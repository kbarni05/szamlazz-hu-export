# Számlázz.hu export Tampermonkeyhez

Tampermonkey userscript kimenő számlák és nyugták Excelbe másolható exportjához.

## Telepítés



https://raw.githubusercontent.com/kbarni05/szamlazz-hu-export/main/szamlazz-export.user.js

## Használat

1. Jelentkezz be a Számlázz.hu oldalára.
2. Nyisd meg a kimenő számlák vagy a nyugták listáját.
3. A jobb alsó exportpanelben válaszd ki a típust, dátumszűrést és az esetleges pótló ÁFA-kulcsot.
4. Kattints az **Ellenőrzés és másolás** gombra.
5. Ellenőrzés után másold az adatokat, majd Excelben nyomj `Ctrl+V`-t.

## Biztonság

A repó nem tartalmaz tokent, cookie-t, jelszót vagy más bejelentkezési adatot. A script kizárólag a böngésző aktuális Számlázz.hu munkamenetét használja, és az esetleg szükséges munkamenet-fejléceket helyben, a böngészőben jegyzi meg.

## Frissítés

A Tampermonkey az userscript fejlécében megadott `@updateURL` és `@downloadURL` alapján tudja automatikusan ellenőrizni az új verziókat.
