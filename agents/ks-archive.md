# KS- og arkiveringsagent

## Formål
Sikre at NSTSF's dokumentation bliver gemt rigtigt og kan findes igen direkte fra sagen.

## Ansvar
- vedligeholde mappestruktur på Google Drive
- arkivere billeder, KS, referater og kontrakter
- forbinde filer og links til den rigtige kunde
- holde dokumentation opdateret og søgbar

## Runtime der er bygget nu
Agenten kører som en lagdelt sync-pipeline i `netlify/functions/gmail-sync.mts`.

1. Ingestion
- henter prioriterede Gmail-tråde
- gemmer kompakt trådrecord i `syncState.ingestion`
- bruger tråd-id, message-id'er, vedhæftningsnavne og body hash som stabil kildeidentitet

2. Klassifikation
- klassificerer tråden som opgave, arkivkandidat eller irrelevant
- gemmer intent, lane, årsag og dokumenttype i `syncState.classification`

3. Resolution
- matcher til konkret kunde/sag via `S-`, `K-` + adresse, adresse, kundedata, sagsopgave, mailtekst, filnavne og PDF-tekst som evidens
- gemmer resultat i `syncState.resolution`
- usikre matches lægges i `syncState.reviewQueue` og oprettes som opgave uden dato, hvis de kræver handling

4. Projection
- arkiverer kun når match er sikkert
- skriver markdown til korrekt Drive-mappe
- linker dokumentet tilbage til kunden
- gemmer projection i `syncState.projectionLog`

5. Idempotens
- bruger `archiveManifest`, `archiveKey`, activityLog og Drive-filnavn som stopklodser mod dubletter
- hvis filen allerede findes, bruges eksisterende fil og sync-loggen støjer ikke med ny arkivering

6. Legacy-beskyttelse
- gamle hardcodede backfills og kendte thread-id-reparationer er slået fra i normal drift
- de kan kun køres eksplicit via legacy-flag, så de ikke overskriver den lagdelte pipeline
- samme regel gælder mail-til-opgave og filarkivering: ingen faste kunde-/adresse-special cases må skrive uden om resolveren

## Output
- filnavn: `YYYY-MM-DD - K-kundenr - S-sag - Byggemodereferat.md`
- mappe: kundens `02 Referater`
- aktivitet: `gmail_archive`
- opdateringskort: linker til Drive-filen når der findes `driveUrl`, ellers til sagen

## Afgrænsning
- automatisk arkivering kræver sikkert match
- manuel review bruges ved tvivl i stedet for forkert arkivering
- PDF-tekst må bruges som evidens, men ikke som eneste gæt ved konkurrerende matches

## Tilknyttede dokumenter
- `ks-archive-operating-rules.md`
- `ks-archive-appendix.md`

## Ved
- hvilke dokumenttyper der hører til hver kunde
- hvor filer skal ligge i Drive
- hvilke kundedokumenter der mangler
- hvilke filer der er klar til godkendelse eller afsendelse

## Skal kunne
- oprette og opdatere kundemapper
- arkivere KS og billeder
- knytte dokumenter til sagen
- understøtte draft-first proces for kundekommunikation
