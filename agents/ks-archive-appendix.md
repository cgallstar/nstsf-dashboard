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
  - `YYYY-MM-DD - Byggemodereferat - SagsID.md`
- fejl og mangler møde:
  - `YYYY-MM-DD - SagsID - Fejl og mangler moede.md`
- afslutningsmøde:
  - `YYYY-MM-DD - SagsID - Afslutningsmoede.md`

## Datokilder
Dato udledes i denne rækkefølge:
1. dato i emnefelt eller mailtekst
2. numerisk dato i mailtekst
3. mailens egen dato

## Sagsidentitet
- primær nøgle: `SagsID`
- fallback: gammelt `Sagsnr.`
- visning i UI: eksempel `1004 C`
- normaliseret match: `1004C`

## Logning i state
Arkiveringen skriver tilbage:
- `docs.referater`
- `docs.byggereferater`
- `activityLog` med type `gmail_archive`
- `syncLog` med `driveUrl`, når Drive-filen findes

## Dedupe-nøgle
Agenten skal stoppe dubletter via to kontroller:
1. `activityLog.archiveKey` for samme tråd, sag, dokumenttype og dokumentdato
2. Drive-opslag efter samme `fileName` i målmappe før upload

## Begrænsning
PDF-indhold er ikke en stabil kilde i denne løsning. Agenten må ikke være afhængig af PDF-tekst for at matche en sag sikkert.
