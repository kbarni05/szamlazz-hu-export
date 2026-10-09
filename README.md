# Számlázz.hu export Tampermonkeyhez

Tampermonkey userscript kimenő számlák és nyugták Excelbe másolható exportjához.

## Telepítés



https://raw.githubusercontent.com/kbarni05/szamlazz-hu-export/main/szamlazz-export.user.js

## Használat

1. Jelentkezz be a Számlázz.hu oldalára.
2. Nyisd meg a kimenő számlák vagy a nyugták listáját.
3. A jobb alsó exportpanelben válaszd ki a típust, a dátum alapját (keltezés vagy teljesítés), a dátumszűrést, a rendezést és az esetleges pótló ÁFA-kulcsot.
4. Kattints az **Ellenőrzés és másolás** gombra.
5. Ellenőrzés után másold az adatokat, majd Excelben nyomj `Ctrl+V`-t.

## Biztonság

A repó nem tartalmaz tokent, cookie-t, jelszót vagy más bejelentkezési adatot. A script kizárólag a böngésző aktuális Számlázz.hu munkamenetét használja. A munkamenet-fejléceket az adott oldalbetöltés memóriájában tartja, nem menti el őket a következő oldalbetöltésre.

## Frissítés

A Tampermonkey és a ScriptCat az userscript fejlécében megadott `@updateURL` és `@downloadURL` alapján tudja ellenőrizni az új verziókat. ScriptCatban a script Settings fülén a Check Update kapcsolót is engedélyezni kell. Minden kiadott javítás verziószám-emeléssel a `main` ágra kerül.

## Változások a 3.2.3 verzióban

- A JSON-válasz elején álló BOM és a szokásos XSSI-védelmi előtag feldolgozása.
- A korábbi oldalbetöltésből mentett cégazonosító és token törlése; az export csak az aktuális oldal API-kéréseiből felismert munkamenetet használja.
- A számla- és nyugtalista tényleges API-útvonalának felismerése, valamint az oldaltól átvett hitelesítési és CSRF-fejlécek használata.
- A más webhelyre vagy nem API-útvonalra küldött kérések nem írhatják felül az export munkamenetét.
- HTML-válasz esetén az elavult fejlécpárral küldött kérés egyszeri újrapróbálása. Tartós HTML-, üres vagy hibás válasznál HTTP-státusz, válaszformátum, átirányítás és útvonal jelenik meg; a válasz tartalma és az URL paraméterei nem kerülnek ebbe a hibaüzenetbe.
- A lista nélküli JSON-válasz egyértelmű hibát ad.

Frissítés után töltsd újra a Számlázz.hu listaoldalát, és várd meg, amíg a számlák vagy nyugták betöltődnek, hogy a script felismerje az aktuális munkamenetet. Ha az API továbbra sem küld JSON-listát, a panel részletes hibaüzenete segít az ok megállapításában.

## Változások a 3.2.2 verzióban

- Az elavult munkamenet-fejlécek törlése és az egyszeri újrapróbálás már 403-as válasznál is működik. Ha közben új munkamenetet ismert fel a script, azt használja az újrapróbáláshoz.
- A tömbként átadott fejléceket is felismeri; `fetch` esetén a ténylegesen használt fejléceket, XHR esetén a teljes fejlécpárt jegyzi meg.
- Az export saját kérései nem írják felül az oldalról újonnan felismert munkamenetet.

Frissítsd a userscriptet a fenti telepítési linkről, majd töltsd újra a Számlázz.hu listaoldalát. Ha a 403-as hiba megmarad, ellenőrizd, hogy a kívánt cég számla- vagy nyugtalistája az oldalon is betöltődik-e; szükség esetén jelentkezz be újra vagy ellenőrizd a hozzáférésedet.

## Tesztelés

A munkamenet-kezelés regressziós tesztjei Node.js 18 vagy újabb verzióval, külön függőség nélkül futtathatók:

```sh
node tests/session.test.cjs
```

A tesztek szimulált API-válaszokat használnak; éles ellenőrzéshez bejelentkezett böngésző szükséges.

## Változások a 3.2.1 verzióban

- 401-es válasznál a script törli a saját elavult munkamenet-fejléceit, és egyszer újrapróbálja a kérést az aktuális böngészős munkamenettel.
- Egyértelmű hibaüzenetet ad, ha új bejelentkezés vagy jogosultság szükséges.

## Változások a 3.2.0 verzióban

- A dátumválasztó külön feliratot kapott a számla- és nyugtaexport paneljén; a fejlécben látható a verziószám.
- Frissítéskor a panel kinyílik, a régi példány paneljét lecseréli.
- Kis képernyőn a panel görgethető, így a dátumválasztó nem lóg ki a nézetből.

## Változások a 3.1.0 verzióban

- Szűrés keltezési vagy teljesítési dátum alapján.
- Rendezés a kiválasztott dátum szerint, legújabb vagy legrégebbi tétellel kezdve.
- A választott dátumalap és rendezés megjegyzése a böngészőben.
- Egyértelmű dátumalap-, legkorábbi- és legkésőbbi-dátum kijelzés az ellenőrző ablakban.

