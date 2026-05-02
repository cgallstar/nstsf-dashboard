# KS- og arkiveringsagent — operating rules

## Trigger
- kører ved `Synk Gmail`
- vurderer hver ny Gmail-tråd

## Første version matcher kun
- `byggemødereferat`
- `byggemøde`

## Arkiveringsregel
En mail må kun arkiveres automatisk når:
- dokumenttypen kan klassificeres sikkert
- mailen kan matches til en konkret sag
- samme tråd ikke allerede er arkiveret for samme dato og sag

## Matching-prioritet
1. adresse
2. kundenavn
3. eksisterende `SagsID` eller gammelt sagsnummer
4. opgavetitel

## Outputregel
- kategori: `referater`
- filformat: markdown
- filnavn: `YYYY-MM-DD - Byggemodereferat - SagsID.md`
- PDF-bilag: `YYYY-MM-DD - Byggemodereferat - SagsID.pdf`

## Dedupe
Samme mailtråd må ikke blive arkiveret to gange for:
- samme sag
- samme dokumenttype
- samme dokumentdato

## Ikke i første version
- bred AI-klassifikation af alle dokumenttyper
- automatisk udledning af action points til `Sager`
