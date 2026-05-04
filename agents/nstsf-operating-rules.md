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
- kundenr. / sagId
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
- fakturastatus og fakturamatch

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
- manuel afklaring i `Opdateringer`, hvis faktura ikke kan matches sikkert

### KS- og arkiveringsagent
Ejer:
- Drive-struktur
- billeder
- KS
- referater
- dokumentlinks
- dedupe ved Drive-arkivering

Læser:
- kundemapper
- dokumentkategorier
- uploadede filer

Skriver:
- arkiverede filer
- links på sagen
- mappestruktur
- `driveUrl` i `syncLog`, så opdateringskort kan åbne arkiverede filer direkte

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

### ID-model
Sag og Kunde er separate entiteter.

Begge kan have numeriske interne IDs:
- `sagId`
- `kundeId`

De må ikke vises som rene tal i brugerfladen, fordi det skaber forveksling.

Visningsregler:
- Sag vises som `S-{sagId}`, fx `S-123`
- Kunde vises som `K-{kundeId}`, fx `K-456`

Sag og Kunde må eksistere hver for sig.

Når en sag kobles til en kunde, skal relationen gemmes som:
```text
SagKunde {
  sagId,
  kundeId
}
```

Relationen betyder kun: `Sag S-123 er koblet til Kunde K-456`.

Inputregler:
- `S-` prefix skal slå op i sager
- `K-` prefix skal slå op i kunder
- input kun med tal, fx `123`, er uklart og skal afvises eller kræve afklaring
- en opgave uden sikker kundekobling må oprettes som ukoblet opgave og vises med en midlertidig `S-xxx` reference, indtil den matches manuelt
- en intern opgave, der kan matches til en kunde, skal vise kundens `K-` nummer i opgavekortet, fx `K-1002`
- et opgavekort må ikke vise en midlertidig `K-xxx` hash; `K-` er kun til kendte kunder

### Kundesag
Felter:
- kundenavn
- adresse
- kundeId / kundenr.
- sagId ved konkret sag
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
- fakturaer -> `06 Faktura / Betaling`
- kontrakter -> `07 Kontrakt / Underskrifter`
- transcripts -> `08 Transkripter`

### Dedupe-regel
Før et dokument uploades til Drive, skal agenten tjekke om samme filnavn allerede findes i målmappe. Hvis ja, bruges eksisterende Drive-fil og linket skrives tilbage til state.

### Porteføljekunder
For kunder med flere poster/sager under samme kundenr., fx DKE / Charlotte, må agenten ikke arkivere på kundenummer alene. Automatisk arkivering kræver sikker `S-` reference, sikker adresse eller anden stærk post-identifikation. Filnavne og opdateringskort skal bruge `K-` kundenr. og `S-` sag, når de findes.

### Beløbsregel
Alle økonomiske beløb i kundesystemet er inkl. moms.

Det gælder:
- fakturabeløb
- udestående beløb
- estimerede entreprisesummer
- tilbudsbeløb
- betalingslinjer
- likviditetsvisning

Hvis et dokument viser subtotal og moms separat, skal agenten registrere `subtotal + moms`.

Hvis et dokument eksplicit angiver et beløb som ekskl. moms, skal agenten omregne til inkl. moms med 25% moms, før beløbet skrives til kunden.

### Fakturamatch
Fakturaer må ikke matches via gæt. Automatisk match kræver eksisterende fakturanr. i state, sikker `S-`/`K-` reference, sikker adresse, stærkt entydigt kundenavn i mailtekst/filnavn/PDF-tekst eller dokumenthistorik på sagen. PDF-tekst må bruges som evidens, men hvis den giver flere nærliggende matches, skal fakturaen blive en manuel afklaring i `Opdateringer`.

Når en faktura matches sikkert, skal fakturabeløbet fra fakturaen opdatere sagens udestående beløb. Eksisterende estimater eller tidligere aconto-beløb må ikke vinde over et sikkert fakturabeløb.

Hvis en relevant mail ikke kan matches sikkert til en eksisterende kunde/sag, må den ikke forsvinde som ren fejl. Den skal oprettes som en intern opgave uden dato med mailens emne og forklaring, så den kan matches manuelt senere.

Opdateringskort for fakturaer skal være konkrete pr. sag/kunde. De må ikke stå som generisk `Fakturaer · Ukendt sag`, når sync faktisk har opdateret en bestemt sag.

Samme tråd eller dokument må kun optræde én gang i `Opdateringer`. En senere succes skal erstatte en tidligere fejl for samme tråd, ikke lægges ved siden af.

Flere opgaver på samme kunde/sag skal samles i samme opgavekort. Delopgaver skal vises som bullets under `Suggestion`, og suggestion-teksten skal kunne redigeres direkte inline.

## Prioriteringsregler

### Grundregler
- kategori `06. Afsluttet` og `07. Ikke relevant` må ikke vises i aktive opgaver
- kategori `04. Tilbud sendt` må ikke alene oprette en opgave
- tilbudsopfølgning bliver kun en aktiv opgave, hvis der findes en uløst mail, der konkret beder om svar, dato, godkendelse eller afklaring; passive syv-dages followups og afledt tilbudsdato må ikke alene skabe opgave
- arkiverede/håndterede mails og `gmail_archive`-aktivitet må ikke genaktivere en sag som opgave
- en opgave markeret `Fuldført` skal ligge i arkiv og må ikke vises i aktive opgaver igen
- samme mail må kun vises én gang: enten som del af en konkret sag eller som løs mailopgave, ikke begge steder
- porteføljekunder må ikke matches på kundenavn alene; kræv adresse, sikker `S-`/`K-` reference eller tydelig opgavetitel
- betalingsopgaver må kun oprettes fra eksplicit åbne betalingsposter; rene `invoice_update`, `Faktura sendt`, afledte betalingslinjer og betalt betalingshistorik må ikke skabe opgave

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
