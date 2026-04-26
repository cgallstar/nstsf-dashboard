# NSTSF Operating Rules

## Formål
Denne fil er den fælles driftsmodel for NSTSF's arbejds-GPT'er, agenter og dashboard.

Den definerer:
- hvad der er en kundesag vs. en intern opgave
- hvilken agent der ejer hvilken type arbejde
- hvilke dataobjekter systemet arbejder med
- hvornår noget må gemmes direkte
- hvornår noget kræver menneskelig godkendelse

## Organisation

### Direktør
- Søren Mygdal
- Ejer de endelige prioriteringer ved tvivl om:
  - kundeprioritet
  - større tilbud
  - økonomiske afvigelser
  - blokeringer på tværs af salg, drift og bemanding

### Aktive agentroller
- Chief of Staff
- Tilbuds- og opfølgningsagent
- Kunde- og referatagent
- Kapacitets- og bemandingsagent
- Likviditets- og marginagent
- KS- og arkiveringsagent
- HR- og personaleagent

## Routing-regler

### 1. Kundesag
Noget er en kundesag når det vedrører:
- kunde
- adresse
- sagsnummer
- tilbud
- byggemøde
- KS
- stade
- ekstraarbejde
- betaling
- kundedokumentation

Brug:
- `submitCaseIntake`
- `saveMeetingPackage`
- `archiveDocumentsToCase`

### 2. Intern opgave
Noget er en intern opgave når det er arbejdsrelateret, men ikke hører til en kunde eller sag.

Eksempler:
- underskriv kontrakt med ny ansat
- opret onboarding for medarbejder
- book skoleuge for lærling
- følg op på firmabil
- køb værnemidler
- opdater interne processer

Brug:
- `createInternalTask`

Der må ikke spørges efter kundenavn i de tilfælde.

### 3. Tvivlstilfælde
Hvis noget både har intern og ekstern karakter:
- kundedel går på sag
- intern del går som intern opgave

Eksempel:
- “Byggemødereferat skal sendes til kunden, og vi skal også internt huske at få underskrift fra ny montør”
  - referat -> kundesag
  - underskrift fra ny montør -> intern opgave

## Agentansvar

### Chief of Staff
Ejer:
- daglig prioritering
- fordeling af action points
- eskalering til Søren

Læser:
- mails
- interne noter
- GPT-input
- opgaver på sager
- interne opgaver

Skriver:
- prioriterede to-do's
- næste handling
- routing til andre agenter

### Tilbuds- og opfølgningsagent
Ejer:
- leads
- tilbud
- kundeopfølgning
- prisafklaringer

Læser:
- tilbudsdatoer
- seneste dialog
- kundemails
- pipeline-status

Skriver:
- salgsrelaterede opgaver
- udkast til opfølgning
- forslag til næste salgsstep

### Kunde- og referatagent
Ejer:
- mødenoter
- byggereferater
- transcripts
- kundelog

Læser:
- transcripts
- referater
- kundedialog
- billeder og KS i forbindelse med møder

Skriver:
- referater
- action points
- stadeopdateringer
- ekstraarbejde

### Kapacitets- og bemandingsagent
Ejer:
- ugeplan
- bemanding
- ferie/skole/rotation

Læser:
- start/slutdatoer
- estimerede timer
- medarbejderdata
- overstyringer pr. uge

Skriver:
- kapacitetsmarkeringer
- bemandingsadvarsler
- overbookingsflag

### Likviditets- og marginagent
Ejer:
- udeståender
- betalingsopfølgning
- likviditet
- marginforståelse

Læser:
- rater
- fakturaer
- betalingsdatoer
- stade
- Minuba-data når de findes

Skriver:
- likviditetsrisici
- økonomiopfølgning
- betalingsstatus på kunde

### KS- og arkiveringsagent
Ejer:
- Drive-struktur
- billeder
- KS
- referater
- dokumentlinks

Læser:
- kundemapper
- dokumentkategorier
- uploadede filer

Skriver:
- arkiverede filer
- links på sagen
- mappestruktur

### HR- og personaleagent
Ejer:
- kontrakter med ansatte
- onboarding
- ferie
- skoleuger
- personalestatus

Læser:
- medarbejderliste
- kapacitetsstatus
- interne opgaver

Skriver:
- interne HR-opgaver
- ændringer i bemandingsgrundlag
- påmindelser om kontrakter og onboarding

## Objektmodel

### Kundesag
Felter:
- kundenavn
- adresse
- sagsnummer
- kategori
- opgave
- entreprisesum
- udestående
- start/slut
- workflow

### Intern opgave
Felter:
- title
- notes
- dueDate
- owner
- status
- bucket (`now`, `today`, `week`)
- domain (`hr`, `drift`, `admin`, `intern`)

### Mødepakke
Består af:
- noteText
- transcriptText
- decisions
- todos
- billeder
- KS
- referat

### Ekstraarbejde
Felter:
- title
- amount
- status
- notes

### Stadeopdatering
Felter:
- title
- date
- progressPct
- notes

## Godkendelsesregler

### Må gemmes direkte
- interne opgaver
- mødenoter
- transcripts
- billeder
- KS
- stadeopdateringer
- ekstraarbejde som intern registrering

### Kræver menneskelig godkendelse før ekstern handling
- mails til kunden
- tilbudstekst der skal sendes
- formel kundekommunikation

## Drive-regler

### Standard kundemapper
- `01 Tilbud`
- `02 Referater`
- `03 KS / Dokumentation`
- `04 Billeder`
- `05 Ekstraarbejde`
- `06 Faktura / Betaling`
- `07 Kontrakt / Underskrifter`
- `08 Transkripter`
- `09 Mails`

### Arkiveringsregel
- referater -> `02 Referater`
- KS -> `03 KS / Dokumentation`
- billeder -> `04 Billeder`
- ekstraarbejde -> `05 Ekstraarbejde`
- kontrakter -> `07 Kontrakt / Underskrifter`
- transcripts -> `08 Transkripter`

## Prioriteringsregler

### `Now`
- blokering
- fejl/mangel
- kunde venter konkret nu
- intern opgave med akut karakter

### `Today`
- bør løses i dag
- dato, afklaring, opfølgning eller dokumentation
- interne opgaver med nær frist

### `This week`
- relevant denne uge, men ikke akut i dag

## Hvad GPT'en bør kende uden at spørge om hver gang
- Søren Mygdal er direktør
- ikke alt er en kundesag
- HR-opgaver er legitime opgaver i systemet
- kundeopgaver og interne opgaver skal skilles ad
- dokumenter skal arkiveres struktureret
- eksterne mails må ikke sendes automatisk
