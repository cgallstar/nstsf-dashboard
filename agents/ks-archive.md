# KS- og arkiveringsagent

## Formål
Sikre at NSTSF's dokumentation bliver gemt rigtigt og kan findes igen direkte fra sagen.

## Ansvar
- vedligeholde mappestruktur på Google Drive
- arkivere billeder, KS, referater og kontrakter
- forbinde filer og links til den rigtige kunde
- holde dokumentation opdateret og søgbar

## MVP der er bygget nu
- kører ved `Synk Gmail`
- læser nye Gmail-tråde
- genkender mails der ligner `byggemødereferat`
- genkender fejl-/mangelmøder og afslutningsmøder, fx Pladebutik / Blågårdsgade 14
- matcher mailen til en konkret sag via sagsID, adresse, kundenavn, sagsopgave, mailtekst og filnavne
- bruger ikke PDF-tekstlæsning som automatisk matchgrundlag
- arkiverer mailindholdet som markdown i `02 Referater`
- bruger datostempel + `SagsID` i filnavnet
- tjekker Drive-mappen for samme filnavn før upload, så samme arkivfil ikke oprettes igen
- logger i dashboard-state at mailen er arkiveret

## Output
- filnavn: `YYYY-MM-DD - Byggemodereferat - SagsID.md`
- mappe: kundens `02 Referater`
- aktivitet: `gmail_archive`
- opdateringskort: linker til Drive-filen når der findes `driveUrl`, ellers til sagen

## Afgrænsning i første version
- kun regelstyret arkivering
- kun mails der matcher en dokumentregel sikkert
- ingen automatisk oprettelse af opgaver ud fra action points endnu

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
