# KS- og arkiveringsagent — operating rules

## Trigger
- kører ved `Synk Gmail`
- vurderer hver ny Gmail-tråd

## Matcher
- `byggemødereferat`
- `byggemøde`
- fejl- og mangelmøder
- afslutningsmøder
- Pladebutik / Blågårdsgade 14 når emnet handler om udbedring, mangler, fejl, dokumentation eller billeder

## Arkiveringsregel
En mail må kun arkiveres automatisk når:
- dokumenttypen kan klassificeres sikkert
- mailen kan matches til en konkret sag
- samme tråd ikke allerede er arkiveret for samme dato og sag
- Drive-mappen ikke allerede indeholder samme filnavn

## Matching-prioritet
1. eksplicit `SagsID`
2. adresse
3. kundenavn + opgavetitel
4. eksisterende Drive-link eller sagsdokumenter

Kundenavn eller kundenummer alene er ikke nok til automatisk arkivering, når kunden har flere poster/sager. For porteføljekunder som DKE / Charlotte skal agenten ramme en konkret post via fuldt sagsID, adresse eller anden stærk post-identifikation.

## Outputregel
- kategori: `referater`
- filformat: markdown
- filnavn: `YYYY-MM-DD - SagsID - Dokumenttype.md`
- `SagsID` skal være fuldt ID med postbogstav, når det findes, fx `1002 C`

## Dedupe
Samme mailtråd må ikke blive arkiveret to gange for:
- samme sag
- samme dokumenttype
- samme dokumentdato

Derudover skal agenten kontrollere Drive-mappen for samme filnavn før upload. Hvis filen allerede findes, skal eksisterende fil bruges og linkes i state i stedet for at uploade en ny kopi.

Hvis Drive allerede indeholder filen, må agenten ikke skrive en ny `Arkiveret`-opdatering. Den skal behandles som `skipped`/allerede arkiveret og ikke støje i `Opdateringer`.

## PDF-regel
PDF-tekstlæsning må ikke bruges som primært matchgrundlag. PDF'er kan være bilag i Drive, men sikker sagstilknytning skal komme fra mailtekst, filnavn, sagsID, adresse eller eksisterende state.

## Opdateringer
Når agenten skriver til `syncLog`, skal den medtage:
- `caseId`
- `documentType`
- `category`
- `fileName`
- `driveUrl` når en Drive-fil findes

Klik på et opdateringskort skal åbne Drive-filen, hvis `driveUrl` findes. Ellers skal kortet åbne sagen, hvis `caseId` kan matches.

## Ikke i første version
- bred AI-klassifikation af alle dokumenttyper
- automatisk udledning af action points til `Sager`
