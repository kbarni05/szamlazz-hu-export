// ==UserScript==
// @name         Számlázz.hu teljes export szűrővel és ÁFA-számítással
// @namespace    https://github.com/kbarni05/szamlazz-hu-export
// @version      3.1.0
// @description  Kimenő számlák és nyugták ellenőrzött, Excelbe másolható exportja választható dátumalappal, rendezéssel és opcionális ÁFA-számítással
// @author       kbarni05
// @homepageURL  https://github.com/kbarni05/szamlazz-hu-export
// @supportURL   https://github.com/kbarni05/szamlazz-hu-export/issues
// @updateURL    https://raw.githubusercontent.com/kbarni05/szamlazz-hu-export/main/szamlazz-export.user.js
// @downloadURL  https://raw.githubusercontent.com/kbarni05/szamlazz-hu-export/main/szamlazz-export.user.js
// @match        https://www.szamlazz.hu/app/*
// @match        https://www.szamlazz.hu/szamla/*
// @grant        GM_setClipboard
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  const STORAGE = {
    companyId: "szamlazz_export_shadow_company_id",
    token: "szamlazz_export_shadow_token",
    vatMode: "szamlazz_export_vat_mode",
    customVatRate: "szamlazz_export_custom_vat_rate",
    roundingMode: "szamlazz_export_rounding_mode",
    dateBasis: "szamlazz_export_date_basis",
    sortDirection: "szamlazz_export_sort_direction",
    minimized: "szamlazz_export_minimized"
  };

  const CONFIG = {
    invoicePageSize: 50,
    receiptPageSize: 50,
    maxPages: 500,
    amountTolerance: 1
  };

  const API = {
    invoice: "https://www.szamlazz.hu/szamla/pcapi/szfej/list/",
    receipt: "https://www.szamlazz.hu/szamla/pcapi/nyfej/list/all"
  };

  const PROJECTION = {
    invoice: JSON.stringify({
      items: {
        szfej: "szfejkimenolist",
        szfejParent: "none",
        szfejVegszamla: "szfejid",
        szfejHelyesbito: "szfejid",
        szfejStornozo: "szfejid",
        sztet: "none",
        payeeCase: "all",
        partner: "all"
      },
      emptyReason: "all",
      hasNextPage: "all",
      totalSize: "all"
    }),
    receipt: JSON.stringify({
      items: {
        nyfej: "list",
        nyfejSend: "list",
        nyfejSendList: "list",
        nyugtaArchivum: "list",
        nyTetItems: "none",
        nyfejhistory: "none",
        usr: "none"
      },
      hasNextPage: "all",
      totalSize: "all"
    })
  };

  let activeController = null;

  function pageWindow() {
    try {
      return typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    } catch (_) {
      return window;
    }
  }

  function normalizeHeaders(headersLike) {
    const result = {};
    if (!headersLike) return result;
    try {
      if (typeof headersLike.forEach === "function") {
        headersLike.forEach((value, key) => {
          result[String(key).toLowerCase()] = value;
        });
      } else if (Array.isArray(headersLike)) {
        for (const [key, value] of headersLike) {
          result[String(key).toLowerCase()] = value;
        }
      } else if (typeof headersLike === "object") {
        for (const [key, value] of Object.entries(headersLike)) {
          result[String(key).toLowerCase()] = value;
        }
      }
    } catch (_) {}
    return result;
  }

  function rememberSessionHeaders(headersLike) {
    const headers = normalizeHeaders(headersLike);
    const companyId = headers["shadow-login-ceg-id"];
    const token = headers["shadow-login-token"];
    let changed = false;

    if (companyId) {
      localStorage.setItem(STORAGE.companyId, String(companyId));
      changed = true;
    }
    if (token) {
      localStorage.setItem(STORAGE.token, String(token));
      changed = true;
    }
    if (changed) {
      window.dispatchEvent(new CustomEvent("szamlazz-export-session-updated"));
    }
  }

  function installRequestInterceptors() {
    const target = pageWindow();
    const originalFetch = target.fetch;
    if (typeof originalFetch === "function" && !originalFetch.__szamlazzExportPatched) {
      const patchedFetch = function (input, init) {
        try {
          rememberSessionHeaders(init?.headers);
          rememberSessionHeaders(input?.headers);
        } catch (_) {}
        return originalFetch.apply(this, arguments);
      };
      patchedFetch.__szamlazzExportPatched = true;
      target.fetch = patchedFetch;
    }

    const proto = target.XMLHttpRequest?.prototype;
    if (!proto || proto.__szamlazzExportPatched) return;
    const originalOpen = proto.open;
    const originalSetHeader = proto.setRequestHeader;
    const originalSend = proto.send;

    proto.open = function () {
      this.__szamlazzExportHeaders = {};
      return originalOpen.apply(this, arguments);
    };
    proto.setRequestHeader = function (name, value) {
      this.__szamlazzExportHeaders ||= {};
      this.__szamlazzExportHeaders[name] = value;
      rememberSessionHeaders(this.__szamlazzExportHeaders);
      return originalSetHeader.apply(this, arguments);
    };
    proto.send = function () {
      rememberSessionHeaders(this.__szamlazzExportHeaders);
      return originalSend.apply(this, arguments);
    };
    proto.__szamlazzExportPatched = true;
  }

  installRequestInterceptors();

  const hasValue = value => value !== undefined && value !== null && value !== "";
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const cleanCell = value => String(value ?? "").replace(/\t/g, " ").replace(/\r?\n/g, " ").trim();
  const escapeHtml = value => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

  function firstExisting(object, keys) {
    for (const key of keys) {
      if (hasValue(object?.[key])) return object[key];
    }
    return "";
  }

  function deepFindValue(root, patterns) {
    const visited = new Set();
    function walk(value) {
      if (!value || typeof value !== "object" || visited.has(value)) return "";
      visited.add(value);
      for (const [key, child] of Object.entries(value)) {
        const normalized = key.toLowerCase();
        if (patterns.some(pattern => pattern.test(normalized)) && hasValue(child) && typeof child !== "object") {
          return child;
        }
      }
      for (const child of Object.values(value)) {
        const result = walk(child);
        if (result !== "") return result;
      }
      return "";
    }
    return walk(root);
  }

  function parseNumber(value) {
    if (!hasValue(value)) return null;
    value = unwrapAmount(value);
    if (!hasValue(value)) return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    let text = String(value)
      .trim()
      .replace(/[\s\u00a0\u202f]/g, "")
      .replace(/(?:Ft|HUF)/gi, "")
      .replace(/[’']/g, "");
    if (text.includes(",") && text.includes(".")) {
      text = text.lastIndexOf(",") > text.lastIndexOf(".")
        ? text.replace(/\./g, "").replace(",", ".")
        : text.replace(/,/g, "");
    } else if (text.includes(",")) {
      text = /^-?\d{1,3}(?:,\d{3})+$/.test(text)
        ? text.replace(/,/g, "")
        : text.replace(",", ".");
    } else if (/^-?\d{1,3}(?:\.\d{3})+$/.test(text)) {
      text = text.replace(/\./g, "");
    }
    const number = Number(text);
    return Number.isFinite(number) ? number : null;
  }

  function unwrapAmount(value) {
    if (!value || typeof value !== "object") return value;
    for (const key of [
      "value", "amount", "osszeg", "ertek", "huf", "valueHuf",
      "amountHuf", "numericValue", "numberValue"
    ]) {
      if (hasValue(value[key]) && typeof value[key] !== "object") return value[key];
    }
    return "";
  }

  function normalizeFieldName(value) {
    return String(value)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]/gi, "")
      .toLowerCase();
  }

  function findAmount(root, candidateKeys) {
    const wanted = new Set(candidateKeys.map(normalizeFieldName));
    const visited = new Set();

    function walk(value) {
      if (!value || typeof value !== "object" || visited.has(value)) return "";
      visited.add(value);

      for (const [key, child] of Object.entries(value)) {
        if (wanted.has(normalizeFieldName(key))) {
          const amount = unwrapAmount(child);
          if (hasValue(amount) && parseNumber(amount) !== null) return amount;
        }
      }

      for (const child of Object.values(value)) {
        const amount = walk(child);
        if (hasValue(amount)) return amount;
      }
      return "";
    }

    return walk(root);
  }

  function roundAmount(value, mode) {
    if (!Number.isFinite(value)) return null;
    return mode === "integer" ? Math.round(value) : Math.round(value * 100) / 100;
  }

  function excelNumber(value) {
    const number = typeof value === "number" ? value : parseNumber(value);
    if (number === null) return "";
    return Number.isInteger(number) ? String(number) : String(number).replace(".", ",");
  }

  function previewNumber(value) {
    const number = typeof value === "number" ? value : parseNumber(value);
    if (number === null) return "-";
    return new Intl.NumberFormat("hu-HU", { maximumFractionDigits: 2 }).format(number);
  }

  function plainDate(value) {
    if (!hasValue(value)) return "";
    let text = String(value).trim();
    const excelMatch = text.match(/^="(.+)"$/);
    if (excelMatch) text = excelMatch[1];
    const match = text.match(/^(\d{4})[.\/-](\d{1,2})[.\/-](\d{1,2})/);
    if (!match) return text.slice(0, 10);
    return [match[1], match[2].padStart(2, "0"), match[3].padStart(2, "0")].join("-");
  }

  const excelDate = value => {
    const date = plainDate(value);
    return date ? `="${date}"` : "";
  };

  function rowBasisDate(row, dateBasis) {
    return dateBasis === "fulfillment" ? row.fulfillmentDate : row.issueDate;
  }

  function validPlainDate(value) {
    const date = plainDate(value);
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
  }

  function dateBasisLabel(dateBasis) {
    return dateBasis === "fulfillment" ? "Teljesítés dátuma" : "Keltezés dátuma";
  }

  function sortDirectionLabel(sortDirection) {
    return sortDirection === "asc" ? "Legrégebbi elöl" : "Legújabb elöl";
  }

  function sortRowsByDate(rows, dateBasis, sortDirection) {
    return [...rows].sort((left, right) => {
      const leftDate = validPlainDate(rowBasisDate(left, dateBasis));
      const rightDate = validPlainDate(rowBasisDate(right, dateBasis));

      if (!leftDate && !rightDate) {
        return String(left.number).localeCompare(String(right.number), "hu", { numeric: true });
      }
      if (!leftDate) return 1;
      if (!rightDate) return -1;

      let result = leftDate.localeCompare(rightDate);
      if (sortDirection === "desc") result *= -1;
      if (result !== 0) return result;

      result = String(left.number).localeCompare(String(right.number), "hu", { numeric: true });
      return sortDirection === "desc" ? -result : result;
    });
  }

  function formatYmd(date) {
    return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
  }

  function filterRange(mode, customFrom, customTo) {
    const now = new Date();
    if (mode === "today") {
      const today = formatYmd(now);
      return { from: today, to: today };
    }
    if (mode === "week") {
      const weekday = now.getDay() || 7;
      const from = new Date(now);
      from.setDate(now.getDate() - weekday + 1);
      const to = new Date(from);
      to.setDate(from.getDate() + 6);
      return { from: formatYmd(from), to: formatYmd(to) };
    }
    if (mode === "month") {
      return {
        from: formatYmd(new Date(now.getFullYear(), now.getMonth(), 1)),
        to: formatYmd(new Date(now.getFullYear(), now.getMonth() + 1, 0))
      };
    }
    if (mode === "year") {
      return { from: `${now.getFullYear()}-01-01`, to: `${now.getFullYear()}-12-31` };
    }
    if (mode === "custom") return { from: customFrom || "", to: customTo || "" };
    return { from: "", to: "" };
  }

  function isDateInRange(value, range) {
    if (!range.from && !range.to) return true;
    const date = plainDate(value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    return (!range.from || date >= range.from) && (!range.to || date <= range.to);
  }

  function buildHeaders(projection) {
    const headers = {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json",
      projection
    };
    const companyId = localStorage.getItem(STORAGE.companyId);
    const token = localStorage.getItem(STORAGE.token);
    if (companyId && token) {
      headers["shadow-login-ceg-id"] = companyId;
      headers["shadow-login-token"] = token;
    }
    return headers;
  }

  async function postJson(url, projection, body, signal) {
    const response = await pageWindow().fetch(url, {
      method: "POST",
      credentials: "include",
      headers: buildHeaders(projection),
      body: JSON.stringify(body),
      signal
    });
    const text = await response.text();
    if (!response.ok) {
      const hint = response.status === 401 || response.status === 403
        ? "\n\nFrissítsd a Számlázz.hu listaoldalt, várd meg a betöltést, majd próbáld újra."
        : "";
      throw new Error(`API hiba: ${response.status} ${response.statusText}${hint}\n\n${text || "Nincs válaszszöveg."}`);
    }
    try {
      return JSON.parse(text);
    } catch (_) {
      throw new Error("A Számlázz.hu válasza nem értelmezhető JSON-ként.");
    }
  }

  function itemsOf(data) {
    return Array.isArray(data?.items) ? data.items : [];
  }

  function totalOf(data) {
    for (const value of [data?.totalSize, data?.totalCount, data?.count]) {
      const number = Number(value);
      if (Number.isFinite(number)) return number;
    }
    return null;
  }

  function hasNext(data, items, fetched, pageSize) {
    if (data?.hasNextPage === false || items.length === 0) return false;
    if (data?.hasNextPage === true) return true;
    const total = totalOf(data);
    if (total !== null) return fetched < total;
    return items.length >= pageSize;
  }

  function invoiceNumber(szfej, item) {
    return firstExisting(szfej, ["szlasz", "szamlaszam", "szamlaSzam", "bizonylatszam", "szamlaSorszam"])
      || deepFindValue(item, [/^szlasz$/, /^szamlaszam$/, /^bizonylatszam$/]);
  }

  function invoiceCustomer(szfej, item) {
    return firstExisting(szfej, ["vevoNev", "vevonev", "vevo", "partnerNev", "partnernev", "cegnev", "nev"])
      || firstExisting(item?.partner, ["nev", "name", "partnerNev", "vevoNev", "cegnev", "companyName"])
      || deepFindValue(item, [/^vevonev$/, /^partnernev$/, /customername/, /buyername/, /^cegnev$/]);
  }

  const invoiceIssueDate = (szfej, item) => firstExisting(szfej, ["keltDat", "keltDatum", "keltezes", "issueDate"])
    || deepFindValue(item, [/^keltdat$/, /keltdatum/, /issuedate/]);
  const invoiceFulfillmentDate = (szfej, item) => firstExisting(szfej, ["teljDat", "teljDatum", "teljesitesDat", "teljesitesDatum", "fulfillmentDate"])
    || deepFindValue(item, [/^teljdat$/, /teljesitesdat/, /fulfillmentdate/]);
  const invoiceDueDate = (szfej, item) => firstExisting(szfej, ["fizHat", "fizHDat", "fizHatarido", "fizetesiHatarido", "fizDat", "dueDate"])
    || deepFindValue(item, [/^fizhat$/, /^fizhdat$/, /fizhatarido/, /duedate/]);
  const NET_KEYS = [
    "netOssz", "nettOssz", "nettoOssz", "netto", "nettoOsszeg",
    "nettoErtek", "osszegNetto", "osszesenNetto", "mindosszesenNetto",
    "netAmount", "netValue", "nettoHuf", "netOsszHuf"
  ];
  const VAT_KEYS = [
    "afaOssz", "áfaOssz", "afa", "áfa", "afaOsszeg", "áfaÖsszeg",
    "afaErtek", "osszegAfa", "osszesenAfa", "vat", "vatAmount", "vatValue"
  ];
  const GROSS_KEYS = [
    "brOssz", "bruttOssz", "bruttoOssz", "brutto", "bruttoOsszeg",
    "bruttoErtek", "osszegBrutto", "osszesenBrutto", "mindosszesenBrutto",
    "vegOssz", "fizetendoOssz", "grossAmount", "grossValue", "bruttoHuf"
  ];

  const invoiceNet = (szfej, item) => findAmount({ szfej, item }, NET_KEYS);
  const invoiceVat = (szfej, item) => findAmount({ szfej, item }, VAT_KEYS);
  const invoiceGross = (szfej, item) => findAmount({ szfej, item }, GROSS_KEYS);

  function receiptNumber(nyfej, item) {
    return firstExisting(nyfej, ["nyugtaszam", "nyugtaSzam", "bizonylatszam"])
      || deepFindValue(item, [/^nyugtaszam$/, /^bizonylatszam$/]);
  }

  const receiptCustomer = (nyfej, item) => firstExisting(nyfej, ["vevoNev", "vevonev", "vevo", "partnerNev", "cegnev", "nev"])
    || deepFindValue(item, [/^vevonev$/, /^partnernev$/, /customername/, /^cegnev$/]);
  const receiptIssueDate = (nyfej, item) => firstExisting(nyfej, ["keltDat", "keltDatum", "keltezes", "issueDate"])
    || deepFindValue(item, [/^keltdat$/, /keltdatum/, /issuedate/]);
  const receiptFulfillmentDate = nyfej => firstExisting(nyfej, ["teljDat", "teljDatum", "teljesitesDat", "teljesitesDatum"]);
  const receiptDueDate = nyfej => firstExisting(nyfej, ["fizHat", "fizHDat", "fizHatarido", "fizetesiHatarido"]);
  const receiptNet = (nyfej, item) => findAmount({ nyfej, item }, NET_KEYS);
  const receiptVat = (nyfej, item) => findAmount({ nyfej, item }, VAT_KEYS);
  const receiptGross = (nyfej, item) => findAmount({ nyfej, item }, GROSS_KEYS);

  function resolveAmounts(netRaw, vatRaw, grossRaw, fallbackVatRate, roundingMode) {
    let net = parseNumber(netRaw);
    let vat = parseNumber(vatRaw);
    let gross = parseNumber(grossRaw);
    const original = { net: net !== null, vat: vat !== null, gross: gross !== null };

    if (vat === null && net !== null && gross !== null) vat = roundAmount(gross - net, roundingMode);
    if (gross === null && net !== null && vat !== null) gross = roundAmount(net + vat, roundingMode);
    if (net === null && gross !== null && vat !== null) net = roundAmount(gross - vat, roundingMode);
    if (net !== null && vat === null && gross === null && fallbackVatRate !== null) {
      vat = roundAmount(net * fallbackVatRate / 100, roundingMode);
      gross = roundAmount(net + vat, roundingMode);
    }
    if (gross !== null && net === null && vat === null && fallbackVatRate !== null) {
      net = roundAmount(gross / (1 + fallbackVatRate / 100), roundingMode);
      vat = roundAmount(gross - net, roundingMode);
    }

    let source = "Hiányos";
    if (original.net && original.vat && original.gross) source = "API";
    else if (net !== null && vat !== null && gross !== null) {
      source = (!original.vat && !original.gross && fallbackVatRate !== null)
        ? `${fallbackVatRate}% alapján számítva`
        : "Részben számítva";
    }
    return { net, vat, gross, source };
  }

  function makeRow(mode, item, fallbackVatRate, roundingMode) {
    const head = mode === "invoice" ? item.szfej || {} : item.nyfej || {};
    const amounts = mode === "invoice"
      ? resolveAmounts(invoiceNet(head, item), invoiceVat(head, item), invoiceGross(head, item), fallbackVatRate, roundingMode)
      : resolveAmounts(receiptNet(head, item), receiptVat(head, item), receiptGross(head, item), fallbackVatRate, roundingMode);

    const number = mode === "invoice" ? invoiceNumber(head, item) : receiptNumber(head, item);
    const customer = mode === "invoice" ? invoiceCustomer(head, item) : receiptCustomer(head, item);
    const issue = mode === "invoice" ? invoiceIssueDate(head, item) : receiptIssueDate(head, item);
    const fulfillment = mode === "invoice" ? invoiceFulfillmentDate(head, item) : receiptFulfillmentDate(head);
    const due = mode === "invoice" ? invoiceDueDate(head, item) : receiptDueDate(head);

    return {
      number: cleanCell(number),
      customer: cleanCell(customer),
      issueDate: excelDate(issue),
      fulfillmentDate: excelDate(fulfillment),
      dueDate: excelDate(due),
      netNumber: amounts.net,
      vatNumber: amounts.vat,
      grossNumber: amounts.gross,
      net: excelNumber(amounts.net),
      vat: excelNumber(amounts.vat),
      gross: excelNumber(amounts.gross),
      amountSource: amounts.source
    };
  }

  async function exportMode(mode, range, fallbackVatRate, roundingMode, dateBasis, sortDirection, log, signal) {
    const isInvoice = mode === "invoice";
    const pageSize = isInvoice ? CONFIG.invoicePageSize : CONFIG.receiptPageSize;
    const url = isInvoice ? API.invoice : API.receipt;
    const projection = isInvoice ? PROJECTION.invoice : PROJECTION.receipt;
    const rows = [];
    const signatures = new Set();
    let fetchedCount = 0;
    let expectedTotal = null;
    let missingBasisDateCount = 0;

    for (let page = 0; page < CONFIG.maxPages; page++) {
      if (signal.aborted) throw new DOMException("Megszakítva", "AbortError");
      log(`${isInvoice ? "Számlák" : "Nyugták"} lekérése: ${page + 1}. oldal\nEddig lekérve: ${fetchedCount} db\nDátum alapja: ${dateBasisLabel(dateBasis)}`);
      const body = isInvoice
        ? { kimeno: true, page, pageSize, orderBy: { orderBy: "ORDERBY_KELTDAT", ascending: false } }
        : { searchKey: "", page, pageSize };
      const data = await postJson(url, projection, body, signal);
      const items = itemsOf(data);
      if (expectedTotal === null) expectedTotal = totalOf(data);

      const first = items[0];
      const last = items[items.length - 1];
      const firstNumber = first ? (isInvoice ? invoiceNumber(first.szfej || {}, first) : receiptNumber(first.nyfej || {}, first)) : "";
      const lastNumber = last ? (isInvoice ? invoiceNumber(last.szfej || {}, last) : receiptNumber(last.nyfej || {}, last)) : "";
      const signature = `${items.length}|${firstNumber}|${lastNumber}`;
      if (items.length && signatures.has(signature)) {
        throw new Error("Az API ugyanazt az oldalt küldte vissza újra; a lapozást leállítottam.");
      }
      signatures.add(signature);
      fetchedCount += items.length;

      for (const item of items) {
        const row = makeRow(mode, item, fallbackVatRate, roundingMode);
        const basisDate = rowBasisDate(row, dateBasis);
        if (!validPlainDate(basisDate)) missingBasisDateCount++;
        if (isDateInRange(basisDate, range)) rows.push(row);
      }

      log(`${isInvoice ? "Számlák" : "Nyugták"} lekérve: ${fetchedCount}${expectedTotal !== null ? ` / ${expectedTotal}` : ""}\nSzűrés után: ${rows.length} db\nDátum alapja: ${dateBasisLabel(dateBasis)}`);
      if (!hasNext(data, items, fetchedCount, pageSize)) break;
      await sleep(100);
    }

    return {
      rows: sortRowsByDate(rows, dateBasis, sortDirection),
      fetchedCount,
      expectedTotal,
      missingBasisDateCount
    };
  }

  function buildOutput(mode, rows) {
    const documentTitle = mode === "receipt" ? "Nyugtaszám" : "Számlaszám";
    const header = ["Sorszám", documentTitle, "Vevő", "Keltezés dátuma", "Teljesítés ideje", "Fizetési határidő", "Nettó összeg", "ÁFA összege", "Bruttó összeg"];
    return [header.join("\t"), ...rows.map((row, index) => [
      index + 1, row.number, row.customer, row.issueDate, row.fulfillmentDate,
      row.dueDate, row.net, row.vat, row.gross
    ].join("\t"))].join("\n");
  }

  function copyText(text) {
    try {
      if (typeof GM_setClipboard === "function") {
        GM_setClipboard(text, "text");
        return true;
      }
    } catch (_) {}
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.cssText = "position:fixed;left:-9999px;top:-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      const success = document.execCommand("copy");
      textarea.remove();
      return success;
    } catch (_) {
      return false;
    }
  }

  function analyzeRows(rows, result, range, dateBasis) {
    const issues = [];
    const warnings = [];
    const seen = new Map();
    const missing = { number: 0, issue: 0, net: 0, vat: 0, gross: 0 };
    const sources = { api: 0, calculated: 0, partial: 0, incomplete: 0 };
    let totalNet = 0, totalVat = 0, totalGross = 0, mismatches = 0;
    let earliestDate = "";
    let latestDate = "";

    for (const row of rows) {
      if (!row.number) missing.number++;
      if (!row.issueDate) missing.issue++;
      if (row.netNumber === null) missing.net++; else totalNet += row.netNumber;
      if (row.vatNumber === null) missing.vat++; else totalVat += row.vatNumber;
      if (row.grossNumber === null) missing.gross++; else totalGross += row.grossNumber;
      if (row.amountSource === "API") sources.api++;
      else if (row.amountSource.includes("%")) sources.calculated++;
      else if (row.amountSource === "Részben számítva") sources.partial++;
      else sources.incomplete++;
      if (row.netNumber !== null && row.vatNumber !== null && row.grossNumber !== null
        && Math.abs(row.grossNumber - row.netNumber - row.vatNumber) > CONFIG.amountTolerance) mismatches++;
      if (row.number) seen.set(row.number, (seen.get(row.number) || 0) + 1);

      const selectedDate = validPlainDate(rowBasisDate(row, dateBasis));
      if (selectedDate) {
        if (!earliestDate || selectedDate < earliestDate) earliestDate = selectedDate;
        if (!latestDate || selectedDate > latestDate) latestDate = selectedDate;
      }
    }

    const duplicates = [...seen.entries()].filter(([, count]) => count > 1);
    if (!rows.length) issues.push("Nincs exportálható tétel.");
    if (missing.number) issues.push(`Hiányzó bizonylatszám: ${missing.number} db`);
    if (missing.issue) issues.push(`Hiányzó keltezési dátum: ${missing.issue} db`);
    if (missing.net) issues.push(`Hiányzó nettó összeg: ${missing.net} db`);
    if (missing.vat) issues.push(`Hiányzó ÁFA összeg: ${missing.vat} db`);
    if (missing.gross) issues.push(`Hiányzó bruttó összeg: ${missing.gross} db`);
    if (duplicates.length) issues.push(`Duplikált bizonylatszám: ${duplicates.slice(0, 10).map(([n, c]) => `${n} (${c}x)`).join(", ")}`);
    if (mismatches) issues.push(`Nettó + ÁFA nem egyezik a bruttóval: ${mismatches} db`);
    if (result.expectedTotal !== null && result.fetchedCount < result.expectedTotal) {
      issues.push(`Az API ${result.expectedTotal} tételt jelzett, de csak ${result.fetchedCount} került lekérésre.`);
    }
    if (sources.calculated) warnings.push(`${sources.calculated} sornál a kiválasztott ÁFA-kulcs alapján történt a számítás.`);
    if (sources.partial) warnings.push(`${sources.partial} sornál meglévő összegekből lett kiszámítva a hiányzó érték.`);
    if (result.missingBasisDateCount) {
      warnings.push(range.from || range.to
        ? `${result.missingBasisDateCount} lekért tételnél nincs ${dateBasisLabel(dateBasis).toLowerCase()}, ezért ezek nem kerülhettek bele a dátumszűrésbe.`
        : `${result.missingBasisDateCount} tételnél nincs ${dateBasisLabel(dateBasis).toLowerCase()}, ezért ezek a rendezett lista végére kerültek.`);
    }
    if (range.from || range.to) warnings.push(`Alkalmazott szűrés (${dateBasisLabel(dateBasis)}): ${range.from || "eleje"} – ${range.to || "vége"}.`);
    return {
      issues, warnings, sources, totalNet, totalVat, totalGross,
      earliestDate, latestDate, ok: issues.length === 0
    };
  }

  function previewRowsHtml(rows) {
    const selected = rows.length > 10 ? [...rows.slice(0, 5), null, ...rows.slice(-5)] : rows;
    return selected.map(row => row === null
      ? '<tr><td colspan="9" style="padding:7px;text-align:center;color:#6b7280">…</td></tr>'
      : `<tr>${[
        row.number, row.customer, plainDate(row.issueDate), plainDate(row.fulfillmentDate), plainDate(row.dueDate),
        row.net, row.vat, row.gross, row.amountSource
      ].map((value, index) => `<td style="padding:5px;border-bottom:1px solid #eee;${index >= 5 && index <= 7 ? "text-align:right" : ""}">${escapeHtml(value)}</td>`).join("")}</tr>`
    ).join("");
  }

  function showPreview(mode, result, range, filterLabel, fallbackVatRate, roundingMode, dateBasis, sortDirection) {
    return new Promise(resolve => {
      const analysis = analyzeRows(result.rows, result, range, dateBasis);
      const overlay = document.createElement("div");
      overlay.style.cssText = "position:fixed;inset:0;z-index:1000001;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.5);font-family:Arial,sans-serif";
      const modal = document.createElement("div");
      modal.style.cssText = "width:min(1250px,97vw);max-height:93vh;overflow:auto;padding:18px;border-radius:14px;background:#fff;color:#111827;box-shadow:0 16px 50px rgba(0,0,0,.35)";
      const issueHtml = analysis.issues.length ? `<ul>${analysis.issues.map(x => `<li>${escapeHtml(x)}</li>`).join("")}</ul>` : "Nem találtam kritikus hibát.";
      const warningHtml = analysis.warnings.length ? `<div style="padding:10px;margin:10px 0;background:#fffbeb;border:1px solid #fcd34d;border-radius:8px"><strong>Figyelmeztetések</strong><ul>${analysis.warnings.map(x => `<li>${escapeHtml(x)}</li>`).join("")}</ul></div>` : "";
      modal.innerHTML = `
        <div style="display:flex;justify-content:space-between;gap:12px"><div><h2 style="margin:0 0 6px">Számlázz.hu export ellenőrzés</h2><strong style="color:${analysis.ok ? "#16a34a" : "#dc2626"}">${analysis.ok ? "✅ Rendben" : "⚠️ Ellenőrzést igényel"}</strong></div><button id="se-close">✕</button></div>
        <div style="padding:12px;margin:14px 0 10px;background:#dbeafe;border:2px solid #2563eb;border-radius:10px;color:#1e3a8a">
          <small style="font-weight:700;text-transform:uppercase;letter-spacing:.04em">Szűrés és rendezés alapja</small><br>
          <strong style="font-size:18px">${escapeHtml(dateBasisLabel(dateBasis))}</strong>
          <span style="margin-left:8px">· ${escapeHtml(sortDirectionLabel(sortDirection))}</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:9px;margin:14px 0">
          ${[
            ["Típus", mode === "invoice" ? "Kimenő számlák" : "Nyugták"], ["Szűrés", filterLabel],
            [`Legkorábbi (${dateBasisLabel(dateBasis)})`, analysis.earliestDate || "–"], [`Legkésőbbi (${dateBasisLabel(dateBasis)})`, analysis.latestDate || "–"],
            ["API-ból lekérve", `${result.fetchedCount}${result.expectedTotal !== null ? ` / ${result.expectedTotal}` : ""}`], ["Exportált sorok", result.rows.length],
            ["Összes nettó", `${previewNumber(analysis.totalNet)} Ft`], ["Összes ÁFA", `${previewNumber(analysis.totalVat)} Ft`],
            ["Összes bruttó", `${previewNumber(analysis.totalGross)} Ft`], ["Kulccsal számítva", `${analysis.sources.calculated} db`]
          ].map(([label, value]) => `<div style="padding:10px;background:#f3f4f6;border-radius:9px"><small style="color:#6b7280">${escapeHtml(label)}</small><br><strong>${escapeHtml(value)}</strong></div>`).join("")}
        </div>
        <div style="padding:10px;background:${analysis.ok ? "#ecfdf5" : "#fef2f2"};border:1px solid ${analysis.ok ? "#86efac" : "#fca5a5"};border-radius:8px">${issueHtml}</div>
        ${warningHtml}
        <div style="padding:10px;margin:10px 0;background:#eff6ff;border:1px solid #93c5fd;border-radius:8px">Pótló ÁFA-kulcs: <strong>${fallbackVatRate === null ? "nincs" : `${fallbackVatRate}%`}</strong> · Kerekítés: <strong>${roundingMode === "integer" ? "egész összeg" : "2 tizedes"}</strong></div>
        <div style="overflow:auto;border:1px solid #e5e7eb;border-radius:8px"><table style="width:100%;border-collapse:collapse;font-size:12px;white-space:nowrap"><thead><tr>${["Bizonylatszám", "Vevő", "Keltezés", "Teljesítés", "Határidő", "Nettó", "ÁFA", "Bruttó", "Forrás"].map(x => `<th style="padding:5px;text-align:left;border-bottom:1px solid #ddd">${x}</th>`).join("")}</tr></thead><tbody>${previewRowsHtml(result.rows)}</tbody></table></div>
        <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:14px"><button id="se-cancel" style="padding:10px 14px">Mégse</button><button id="se-copy" style="padding:10px 14px;border:0;border-radius:8px;background:${analysis.ok ? "#16a34a" : "#f97316"};color:#fff;font-weight:700">${analysis.ok ? "Másolás Excelhez" : "Másolás így is"}</button></div>`;
      overlay.appendChild(modal);
      document.body.appendChild(overlay);
      let done = false;
      const close = value => {
        if (done) return;
        done = true;
        document.removeEventListener("keydown", escapeHandler);
        overlay.remove();
        resolve(value);
      };
      const escapeHandler = event => event.key === "Escape" && close(false);
      modal.querySelector("#se-close").addEventListener("click", () => close(false));
      modal.querySelector("#se-cancel").addEventListener("click", () => close(false));
      modal.querySelector("#se-copy").addEventListener("click", () => close(true));
      overlay.addEventListener("click", event => event.target === overlay && close(false));
      document.addEventListener("keydown", escapeHandler);
    });
  }

  function detectMode() {
    const path = location.pathname.toLowerCase();
    if (path.includes("nyugtalista")) return "receipt";
    if (path.includes("szamlalista")) return "invoice";
    return "unknown";
  }

  function createSelect(options) {
    const select = document.createElement("select");
    select.style.cssText = "width:100%;padding:8px;margin-bottom:8px;border:0;border-radius:8px;background:#fff;color:#111827;box-sizing:border-box";
    for (const [label, value] of options) select.add(new Option(label, value));
    return select;
  }

  function createPanel() {
    if (!document.body || document.getElementById("szamlazz-export-panel")) return;
    const panel = document.createElement("div");
    panel.id = "szamlazz-export-panel";
    panel.style.cssText = "position:fixed;right:18px;bottom:88px;z-index:999999;width:350px;padding:12px;box-sizing:border-box;border-radius:12px;background:#1f2937;color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.25);font-family:Arial,sans-serif";
    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin-bottom:9px";
    header.innerHTML = '<strong>Számlázz.hu export</strong><button id="se-minimize" title="Panel összecsukása" style="border:0;border-radius:6px;padding:3px 8px;cursor:pointer">−</button>';
    const body = document.createElement("div");

    const modeSelect = createSelect([["Automatikus felismerés", "auto"], ["Nyugták", "receipt"], ["Kimenő számlák", "invoice"]]);
    const dateBasisSelect = createSelect([["Dátum alapja: Keltezés dátuma", "issue"], ["Dátum alapja: Teljesítés dátuma", "fulfillment"]]);
    const filterSelect = createSelect([["Összes tétel", "all"], ["Mai nap", "today"], ["Aktuális hét", "week"], ["Aktuális hónap", "month"], ["Aktuális év", "year"], ["Egyedi dátumtartomány", "custom"]]);
    const sortSelect = createSelect([["Rendezés: Legújabb elöl", "desc"], ["Rendezés: Legrégebbi elöl", "asc"]]);
    const vatSelect = createSelect([["Hiányzó ÁFA pótlása: 27%", "27"], ["Hiányzó ÁFA pótlása: 18%", "18"], ["Hiányzó ÁFA pótlása: 5%", "5"], ["Hiányzó ÁFA pótlása: 0%", "0"], ["Egyedi ÁFA-kulcs", "custom"], ["Ne számolja ki", "none"]]);
    const roundingSelect = createSelect([["Számítás kerekítése: 2 tizedes", "decimal"], ["Számítás kerekítése: egész összeg", "integer"]]);

    const dateBox = document.createElement("div");
    dateBox.style.cssText = "display:none;gap:6px;margin-bottom:8px";
    const fromInput = document.createElement("input");
    const toInput = document.createElement("input");
    for (const input of [fromInput, toInput]) {
      input.type = "date";
      input.style.cssText = "width:50%;padding:8px;border:0;border-radius:8px;box-sizing:border-box";
      dateBox.appendChild(input);
    }

    const customVatInput = document.createElement("input");
    customVatInput.type = "number";
    customVatInput.min = "0";
    customVatInput.max = "100";
    customVatInput.step = "0.01";
    customVatInput.placeholder = "Egyedi ÁFA-kulcs";
    customVatInput.style.cssText = "display:none;width:100%;padding:8px;margin-bottom:8px;border:0;border-radius:8px;box-sizing:border-box";

    const warning = document.createElement("div");
    warning.style.cssText = "margin-bottom:9px;padding:8px;border-radius:8px;background:#78350f;color:#fef3c7;font-size:11px;line-height:1.35";
    const sessionStatus = document.createElement("div");
    sessionStatus.style.cssText = "margin-bottom:8px;color:#d1d5db;font-size:11px;line-height:1.4";
    const actionButton = document.createElement("button");
    actionButton.textContent = "Ellenőrzés és másolás";
    actionButton.style.cssText = "width:100%;padding:10px;border:0;border-radius:8px;background:#ff5a1f;color:#fff;cursor:pointer;font-weight:700";
    const stopButton = document.createElement("button");
    stopButton.textContent = "Leállítás";
    stopButton.style.cssText = "display:none;width:100%;padding:9px;margin-top:6px;border:1px solid #fca5a5;border-radius:8px;background:#7f1d1d;color:#fff;cursor:pointer;font-weight:700";
    const status = document.createElement("div");
    status.textContent = "Készen áll.";
    status.style.cssText = "margin-top:8px;max-height:160px;overflow:auto;white-space:pre-wrap;font-size:12px;line-height:1.4";

    const savedVat = localStorage.getItem(STORAGE.vatMode);
    vatSelect.value = [...vatSelect.options].some(option => option.value === savedVat) ? savedVat : "27";
    roundingSelect.value = localStorage.getItem(STORAGE.roundingMode) === "integer" ? "integer" : "decimal";
    dateBasisSelect.value = localStorage.getItem(STORAGE.dateBasis) === "fulfillment" ? "fulfillment" : "issue";
    sortSelect.value = localStorage.getItem(STORAGE.sortDirection) === "asc" ? "asc" : "desc";
    customVatInput.value = localStorage.getItem(STORAGE.customVatRate) || "";

    function updateWarning() {
      customVatInput.style.display = vatSelect.value === "custom" ? "block" : "none";
      warning.textContent = vatSelect.value === "none"
        ? "Ha az API nem ad ÁFA- vagy bruttóértéket, ezek a cellák üresen maradnak."
        : `A hiányzó ÁFA és bruttó ${vatSelect.value === "custom" ? "az egyedi kulcs" : `${vatSelect.value}%`} alapján lesz kiszámítva. Vegyes ÁFA-kulcsú bizonylatoknál válassz megfelelőbb módszert.`;
    }
    function updateSessionStatus() {
      const companyId = localStorage.getItem(STORAGE.companyId);
      const token = localStorage.getItem(STORAGE.token);
      sessionStatus.textContent = companyId && token
        ? `Munkamenet felismerve · Cég ID: ${companyId}`
        : "A böngésző aktuális Számlázz.hu munkamenetét használom. Ha jogosultsági hiba jelenik meg, frissítsd a listaoldalt.";
    }
    function log(message) {
      status.textContent = message;
      console.log("[Számlázz export]", message);
    }
    function selectedVatRate() {
      if (vatSelect.value === "none") return null;
      const value = Number(vatSelect.value === "custom" ? customVatInput.value : vatSelect.value);
      if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error("Az ÁFA-kulcs 0 és 100 közötti szám legyen.");
      return value;
    }
    function setBusy(busy) {
      actionButton.disabled = busy;
      actionButton.textContent = busy ? "Lekérés folyamatban…" : "Ellenőrzés és másolás";
      stopButton.style.display = busy ? "block" : "none";
    }

    filterSelect.addEventListener("change", () => {
      dateBox.style.display = filterSelect.value === "custom" ? "flex" : "none";
    });
    dateBasisSelect.addEventListener("change", () => localStorage.setItem(STORAGE.dateBasis, dateBasisSelect.value));
    sortSelect.addEventListener("change", () => localStorage.setItem(STORAGE.sortDirection, sortSelect.value));
    vatSelect.addEventListener("change", () => {
      localStorage.setItem(STORAGE.vatMode, vatSelect.value);
      updateWarning();
    });
    customVatInput.addEventListener("change", () => localStorage.setItem(STORAGE.customVatRate, customVatInput.value));
    roundingSelect.addEventListener("change", () => localStorage.setItem(STORAGE.roundingMode, roundingSelect.value));
    stopButton.addEventListener("click", () => activeController?.abort());

    actionButton.addEventListener("click", async () => {
      try {
        setBusy(true);
        let mode = modeSelect.value === "auto" ? detectMode() : modeSelect.value;
        if (mode === "unknown") throw new Error("Válaszd ki kézzel, hogy nyugtákat vagy kimenő számlákat exportálsz.");
        const range = filterRange(filterSelect.value, fromInput.value, toInput.value);
        if (range.from && range.to && range.from > range.to) throw new Error("A kezdő dátum nem lehet későbbi a záró dátumnál.");
        if (filterSelect.value === "custom" && !range.from && !range.to) throw new Error("Adj meg legalább egy dátumot.");
        const fallbackVatRate = selectedVatRate();
        const roundingMode = roundingSelect.value === "integer" ? "integer" : "decimal";
        const dateBasis = dateBasisSelect.value === "fulfillment" ? "fulfillment" : "issue";
        const sortDirection = sortSelect.value === "asc" ? "asc" : "desc";
        activeController = new AbortController();
        const result = await exportMode(mode, range, fallbackVatRate, roundingMode, dateBasis, sortDirection, log, activeController.signal);
        if (!result.rows.length) throw new Error("A kiválasztott szűrésre nincs exportálható tétel.");
        const filterLabel = filterSelect.options[filterSelect.selectedIndex]?.textContent || "Ismeretlen szűrés";
        const confirmed = await showPreview(mode, result, range, filterLabel, fallbackVatRate, roundingMode, dateBasis, sortDirection);
        if (!confirmed) {
          log(`Másolás megszakítva.\nLekért tételek: ${result.fetchedCount}\nExportált sorok: ${result.rows.length}`);
          return;
        }
        const output = buildOutput(mode, result.rows);
        if (!copyText(output)) {
          console.log(output);
          throw new Error("Nem sikerült a vágólapra másolni; az adatok a Console-ban láthatók.");
        }
        const analysis = analyzeRows(result.rows, result, range, dateBasis);
        log(`Kész, kimásolva.\nExportált sorok: ${result.rows.length}\nÖsszes nettó: ${previewNumber(analysis.totalNet)} Ft\nÖsszes ÁFA: ${previewNumber(analysis.totalVat)} Ft\nÖsszes bruttó: ${previewNumber(analysis.totalGross)} Ft\n\nExcelben Ctrl+V.`);
      } catch (error) {
        if (error?.name === "AbortError") log("A lekérést leállítottad.");
        else {
          console.error("[Számlázz export]", error);
          log(`Hiba:\n${error?.message || String(error)}`);
        }
      } finally {
        activeController = null;
        setBusy(false);
        updateSessionStatus();
      }
    });

    body.append(modeSelect, dateBasisSelect, filterSelect, dateBox, sortSelect, vatSelect, customVatInput, roundingSelect, warning, sessionStatus, actionButton, stopButton, status);
    panel.append(header, body);
    document.body.appendChild(panel);

    const minimize = header.querySelector("#se-minimize");
    const startMinimized = localStorage.getItem(STORAGE.minimized) === "1";
    function setMinimized(value) {
      body.style.display = value ? "none" : "block";
      minimize.textContent = value ? "+" : "−";
      minimize.title = value ? "Panel kinyitása" : "Panel összecsukása";
      localStorage.setItem(STORAGE.minimized, value ? "1" : "0");
    }
    minimize.addEventListener("click", () => setMinimized(body.style.display !== "none"));
    window.addEventListener("szamlazz-export-session-updated", updateSessionStatus);
    setMinimized(startMinimized);
    updateWarning();
    updateSessionStatus();
  }

  function waitForBody() {
    if (document.body) createPanel();
    else setTimeout(waitForBody, 200);
  }

  waitForBody();
})();
