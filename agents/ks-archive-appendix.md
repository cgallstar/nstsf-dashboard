# KS- og arkiveringsagent — appendix

## Drive-struktur
- `01 Tilbud`
- `02 Referater`
- `03 KS / Dokumentation`
- `04 Billeder`
- `05 Ekstraarbejde`
- `06 Faktura / Betaling`
- `07 Kontrakt / Underskrifter`
- `08 Transkripter`
- `09 Mails`

## Navngivning i første version
- byggemødereferat:
  - `YYYY-MM-DD - K-kundenr - S-sag - Byggemodereferat.md`
- fejl og mangler møde:
  - `YYYY-MM-DD - K-kundenr - S-sag - Fejl og mangler moede.md`
- afslutningsmøde:
  - `YYYY-MM-DD - K-kundenr - S-sag - Afslutningsmoede.md`

## Datokilder
Dato udledes i denne rækkefølge:
1. dato i emnefelt eller mailtekst
2. numerisk dato i mailtekst
3. mailens egen dato

## Sagsidentitet
- primær nøgle: `S-` sag
- sekundær nøgle: `K-` kunde + sikker adresse
- rå tal uden prefix er uklare og må ikke bruges alene
- visning i UI: eksempel `1004 C`
- normaliseret match: `1004C`

## Logning i state
Arkiveringen skriver tilbage:
- `docs.referater`
- `docs.byggereferater`
- `activityLog` med type `gmail_archive`
- `syncLog` med `driveUrl`, når Drive-filen findes
- `syncState.ingestion`
- `syncState.classification`
- `syncState.resolution`
- `syncState.projectionLog`
- `syncState.reviewQueue`
- `syncState.archiveManifest`

## Legacy-state
Legacy-seeds og kendte engangsbackfills må ikke indgå i normal state-projektion. De er kun tilladt som eksplicit reparation og skal fremgå af sync-resultatet med `legacyBackfillsEnabled: true`.

## Dedupe-nøgle
Agenten skal stoppe dubletter via to kontroller:
1. `archiveManifest.archiveKey`
2. `activityLog.archiveKey` for samme tråd, sag, dokumenttype og dokumentdato
3. Drive-opslag efter samme `fileName` i målmappe før upload
4. `syncState.projectionLog`, så samme projection ikke behandles som ny

## PDF-regel
PDF-indhold må bruges som evidens for adresse, fakturanr., dato, dokumenttype og beløb.

PDF-indhold må ikke alene overstyre et stærkere match, og hvis PDF/mailtekst peger på flere nærliggende sager, skal tråden i `reviewQueue` i stedet for at blive arkiveret forkert.
