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

A repó nem tartalmaz tokent, cookie-t, jelszót vagy más bejelentkezési adatot. A script kizárólag a böngésző aktuális Számlázz.hu munkamenetét használja, és az esetleg szükséges munkamenet-fejléceket helyben, a böngészőben jegyzi meg.

## Frissítés

A Tampermonkey az userscript fejlécében megadott `@updateURL` és `@downloadURL` alapján tudja automatikusan ellenőrizni az új verziókat.

## Változások a 3.2.0 verzióban

- A dátumválasztó külön feliratot kapott a számla- és nyugtaexport paneljén; a fejlécben látható a verziószám.
- Frissítéskor a panel kinyílik, a régi példány paneljét lecseréli.
- Kis képernyőn a panel görgethető, így a dátumválasztó nem lóg ki a nézetből.

## Változások a 3.1.0 verzióban

- Szűrés keltezési vagy teljesítési dátum alapján.
- Rendezés a kiválasztott dátum szerint, legújabb vagy legrégebbi tétellel kezdve.
- A választott dátumalap és rendezés megjegyzése a böngészőben.
- Egyértelmű dátumalap-, legkorábbi- és legkésőbbi-dátum kijelzés az ellenőrző ablakban.
