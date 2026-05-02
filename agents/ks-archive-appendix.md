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
