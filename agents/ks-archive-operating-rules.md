# KS- og arkiveringsagent — operating rules

## Trigger
- kører ved `Synk Gmail`
- vurderer hver ny Gmail-tråd
- kører også ved scheduled morgensync, når automation/Netlify-schedule kalder samme endpoint

## Pipeline-lag
Agenten må ikke behandle Gmail som en løs liste af mails. Hver tråd skal gennem disse lag:

1. `ingestion`
- gem tråd-id, history-id, seneste message-id, afsender, emne, vedhæftningsnavne og body-hash
- samme tråd uden ny besked må ikke behandles igen som ny hændelse

2. `classification`
- afgør om tråden er `task_candidate`, `archive_candidate` eller `ignore`
- gem begrundelsen, så fejl kan spores

3. `resolution`
- match til kunde/sag eller marker som `needs_review`
- usikkert match må ikke arkiveres automatisk

4. `projection`
- skriv først til kunde/Drive/state, når resolution er sikker
- gem `archiveKey`, `fileName`, `driveUrl`, `caseId` og dokumenttype

5. `reviewQueue`
- usikre eller tvetydige sager dedupes på thread-id
- samme fejl må kun stå én gang, selvom sync køres igen

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
1. eksplicit `S-` sag eller `K-` kunde + sikker adresse
2. adresse
3. kundenavn + opgavetitel
4. eksisterende Drive-link eller sagsdokumenter

Kundenavn eller kundenummer alene er ikke nok til automatisk arkivering, når kunden har flere poster/sager. For porteføljekunder som DKE / Charlotte skal agenten ramme en konkret post via `S-` reference, adresse eller anden stærk post-identifikation. Rå tal uden prefix, fx `1002`, er uklare og må ikke alene styre arkivering.

## Legacy-regel
Normal sync må ikke bruge gamle hardcodede backfills, kendte thread-id'er eller konkrete kundeoprettelser som genvej. Legacy-reparationer må kun køre, hvis `ENABLE_LEGACY_GMAIL_BACKFILLS=true` eller request body eksplicit sætter `runLegacyBackfills: true`.

Konsekvens:
- kendte engangsrettelser må ikke overskrive resolverens resultat
- sync må ikke oprette konkrete kunder som Lundebjergvej eller Gadesvej fra frontend/backend seed-logik
- gamle mappings som fakturanummer -> kunde må ikke bruges i normal drift
- mail-til-opgave må ikke bruge gamle konkrete tekstregler for DKE/Charlotte, Gadesvej, Lundebjergvej eller enkeltfakturaer
- filarkivering må ikke bruge faste Drive-mapper eller kendte thread-id'er uden om resolver/projection
- hvis generisk matching ikke er sikker, skal tråden i `reviewQueue`

## Outputregel
- kategori: `referater`
- filformat: markdown
- filnavn: `YYYY-MM-DD - K-kundenr - S-sag - Dokumenttype.md`
- hvis `S-` endnu ikke findes, bruges `K-kundenr` + adresse i filnavnet

## Dedupe
Samme mailtråd må ikke blive arkiveret to gange for:
- samme sag
- samme dokumenttype
- samme dokumentdato
- samme `archiveKey`

Derudover skal agenten kontrollere Drive-mappen for samme filnavn før upload. Hvis filen allerede findes, skal eksisterende fil bruges og linkes i state i stedet for at uploade en ny kopi.

Hvis Drive allerede indeholder filen, må agenten ikke skrive en ny `Arkiveret`-opdatering. Den skal behandles som `skipped`/allerede arkiveret og ikke støje i `Opdateringer`.

## PDF-regel
PDF-tekstlæsning må bruges som evidens, især for fakturaer, men aldrig som gæt. Hvis PDF-teksten giver adresse, fakturanr., dato og beløb, må den indgå i sikker matching. Hvis den matcher flere nærliggende sager, skal agenten skrive en manuel afklaring i `Opdateringer`.

Alle beløb udtrukket fra PDF'er skal gemmes inkl. moms. Ved subtotal + moms bruges totalen. Ved eksplicit ekskl. moms omregnes til inkl. moms.

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
- fuld automatisk løsning af manuelle review-items uden brugerbeslutning
