# Nova AI Studio

Nova AI Studio pune chatul, programarea pentru PC, versurile, schițele muzicale și proiectele video în același spațiu. Agentul poate citi și scrie fișierele proiectului când îi activezi explicit permisiunea.

## Ce poate genera

- **Chat și cod:** folosește Ollama local sau un model OpenAI / compatibil. Agentul are unelte limitate la fișierele proiectului.
- **Versuri și compoziție:** scrie versuri și schițe muzicale originale. Exportul WAV folosește un sintetizator simplu de note; nu cântă versurile.
- **Imagini:** modelul de imagini configurat poate genera ilustrații PNG.
- **Voice-over:** modelul de vorbire poate genera un MP3 din text.
- **Video:** Nova compune scene în WebM din text și, opțional, imagini AI; poate adăuga voice-over ca pistă audio. Nu generează încă filmări AI fotorealiste.

Apelurile către modele cloud pot fi tarifate de furnizor. Nova nu include chei API și nu le trimite în repository.

## Publicare online personală

`site/` este pagina publică GitHub Pages pentru prezentare, confidențialitate și descărcare. GitHub Pages nu rulează serverul AI. Pentru aplicația funcțională online, proiectul include un serviciu Docker pentru Render și un deployment Docker Compose.

### Deploy pe Render

1. Deschide [Deploy Nova AI Studio pe Render](https://render.com/deploy?repo=https://github.com/adyady0303-hash/nova-ai-studio) și conectează contul GitHub.
2. Blueprint-ul `render.yaml` configurează serverul Node, autentificarea cu parolă, un volum persistent pentru proiecte și configurarea API OpenAI.
3. Introdu cheia API numai în formularul privat Render. Nu o adăuga în GitHub, în pagina publică sau în conversații.
4. După deploy, administratorul intră cu utilizatorul și parola din dashboard. Vizitatorii pot apăsa „Creează un cont de abonat” pentru un spațiu privat separat.

Pagina de autentificare permite vizitatorilor să-și creeze conturi separate de abonat. Proiectele lor sunt private, iar administratorul păstrează spațiul și setările AI existente. Un cont de abonat are implicit 5 cereri AI pe zi și cel mult 10 proiecte; apelurile folosesc furnizorul AI configurat de administrator și pot avea costuri.

### Deploy cu Docker

1. Instalează Docker cu suport pentru Compose.
2. Copiază `.env.example` în `.env` și setează o parolă aleatoare de cel puțin 20 de caractere. Adaugă cheia furnizorului AI în `.env` sau lasă cheia necompletată și configureaz-o din fereastra Nova.
3. Din directorul proiectului rulează `docker compose up -d --build`.
4. Deschide `http://localhost:4173`. Pentru expunere pe internet, pune containerul în spatele unui proxy HTTPS (de exemplu Caddy) și păstrează autentificarea pornită.

Volumul Docker `nova-data` păstrează proiectele și copiile de rezervă la repornire. Fără un disk persistent montat, datele locale ale unui serviciu cloud pot dispărea la redeploy.

## Pornire locală pe Windows

1. Instalează Node.js 22 sau mai nou. Dacă folosești modele locale, pornește Ollama.
2. Rulează `npm ci` în directorul aplicației. Pentru Ollama, descarcă și modelul cu `ollama pull qwen3` sau alege un alt model cu tool calling.
3. Deschide `Start_Nova_AI_Studio.bat`. Nova caută un port liber între 4173 și 4190.
4. În Nova, deschide **Configurare AI** și selectează Ollama sau un endpoint cloud.

Înainte de prima pornire, rulează `npm ci` în directorul aplicației pentru instalarea dependențelor. Proiectele și backup-urile rămân în dosarul aplicației când rulezi local.

## Configurare server

| Variabilă | Scop |
| --- | --- |
| `HOST` / `PORT` | Adresa și portul serverului. Pentru publicare folosește `0.0.0.0` și portul dat de hosting. |
| `NOVA_ACCESS_USER` / `NOVA_ACCESS_PASSWORD` | Autentificare prin formular Nova și cookie de sesiune `HttpOnly`, `Secure` și `SameSite`; parola trebuie să aibă cel puțin 20 de caractere pe host public. |
| `NOVA_DATA_DIR` | Rădăcina proiectelor, backup-urilor și coșului de gunoi. Montează aici storage persistent. |
| `NOVA_MAX_ACCOUNTS` | Numărul maxim de conturi de abonat; implicit `100`. |
| `NOVA_SUBSCRIBER_DAILY_AI_LIMIT` | Cereri AI gratuite zilnice; implicit `5`, cel mult `5`. Planul Standard are o cotă separată de 300 pe perioadă lunară plătită. |
| `AI_PROVIDER` | `ollama` sau `openai`. |
| `OLLAMA_URL` | Endpoint-ul Ollama accesibil serverului; implicit `http://127.0.0.1:11434`. |
| `OPENAI_BASE_URL` / `OPENAI_API_KEY` | Endpoint și cheie API pentru serviciu OpenAI compatibil. |
| `OPENAI_MODEL` / `OPENAI_IMAGE_MODEL` / `OPENAI_SPEECH_MODEL` | Modelele pentru chat, generare de imagini și voce. |

Cheia setată prin interfața Nova se păstrează numai în memoria procesului. Pentru instanțe găzduite, configureaz-o în secretele furnizorului de hosting, ca să supraviețuiască repornirilor.

Conturile sunt salvate în `NOVA_DATA_DIR/data/subscriber-accounts.json`, cu parole protejate prin scrypt. Datele fiecărui abonat sunt păstrate în `NOVA_DATA_DIR/users/<account-id>/`; păstrează `NOVA_DATA_DIR` pe un volum persistent.

## Pagina publică și versiuni

- GitHub Pages publică automat directorul `site/` la `https://adyady0303-hash.github.io/nova-ai-studio/`.
- Schimbarea versiunii din `package.json` pe ramura `main` creează automat o arhivă Windows/Linux și suma SHA-256 în GitHub Releases. Workflow-ul poate fi pornit și manual din Actions.
- Pentru sursă, bug-uri și actualizări: [repository Nova AI Studio](https://github.com/adyady0303-hash/nova-ai-studio).


## Abonamente pentru vizitatori

Pagina publică `/plans.html` prezintă planurile, iar meniul contului oferă acces la abonamente:

- Gratuit: 5 cereri AI pe zi (UTC), chat, cod și texte, până la 10 proiecte private.
- Standard: 9,99 EUR/lună, 300 de cereri AI pe perioada lunară plătită și până la 10 proiecte private. Cota nu se reportează.
- Vocea AI rostită este disponibilă vizitatorilor autentificați, cu redare și descărcare MP3. Consumă o unitate din aceeași cotă pentru fiecare segment de până la 500 de caractere; cota insuficientă respinge cererea fără consum parțial. Nu este voce cântată. Imaginile rămân blocate pentru vizitatori, fără consumarea cotei. Administratorul își păstrează accesul existent.
- O cerere AI acceptată consumă o unitate, inclusiv în cazul unei erori a furnizorului. Testul care generează un răspuns consumă o cerere; verificarea conexiunii `/api/health` nu consumă mesaje.

Contul bancar este destinația încasărilor. Pentru plata online cu Visa/Mastercard este necesar un procesator de plăți; datele cardului nu sunt colectate de Nova.

### Transfer bancar, fără cont Stripe

1. Administratorul deschide `/admin.html`, secțiunea **Încasări pentru abonamente**, și salvează numele beneficiarului și un IBAN valid pentru încasări EUR. Sunt date afișate plătitorilor, nu credențiale de acces la bancă. Se păstrează în depozitul de conturi existent. Opțional, `NOVA_BANK_IBAN` și `NOVA_BANK_BENEFICIARY` furnizează configurația inițială din variabilele serverului, dacă nu există deja una salvată în panou.
2. Vizitatorul autentificat alege **Plătește prin transfer bancar** din `/plans.html`. Primește beneficiarul, IBAN-ul, suma fixă de 9,99 EUR și o referință unică `NOVA-...`. Solicitările repetate reutilizează aceeași referință în așteptare.
3. Administratorul verifică extrasul bancar și confirmă încasarea exactă în panou. Nu există verificare bancară automată; o solicitare sau o captură de ecran a vizitatorului nu dovedește încasarea. Confirmarea este disponibilă exclusiv contului de administrator și protejată împotriva cererilor din alte origini.
4. Confirmarea acordă 300 de cereri pentru o lună calendaristică de la confirmare, cu limitare la ultima zi a lunii când este necesar. Nu există debitare sau reînnoire automată. Confirmarea repetată a aceleiași referințe nu extinde accesul și nu reînnoiește cota.
5. La expirare contul revine automat la Gratuit; vizitatorul poate solicita un nou transfer. Abonamentele deja active nu pot fi activate din nou printr-un transfer duplicat. Instrucțiunile unui transfer existent păstrează contul și beneficiarul originale chiar dacă administratorul schimbă ulterior contul de încasare.

### Activarea plăților prin Stripe (opțional, necesită cont de comerciant)

Fără configurare Stripe, aplicația, planul Gratuit și transferul bancar configurat funcționează, dar butonul de plată cu cardul este dezactivat. Nicio încasare sau activare Standard nu este simulată. Cheia OpenAI existentă nu se modifică.

1. În Stripe creează produsul Standard cu un preț recurent lunar de exact **9,99 EUR** (fără perioadă de probă, cupoane sau modificări ale cantității în această integrare). Folosește inițial modul de testare.
2. În setările securizate ale serverului Render, configurează:
   - `STRIPE_SECRET_KEY`: cheia secretă Stripe; niciodată în Git sau browser.
   - `STRIPE_STANDARD_PRICE_ID`: identificatorul `price_...` al prețului lunar.
   - `STRIPE_WEBHOOK_SECRET`: secretul de semnare al endpointului webhook. Este necesară valoarea reală în procesul serverului pentru verificarea HMAC; un substituent de proxy nu funcționează.
   - `NOVA_PUBLIC_URL`: `https://www.nova-ai-studio.eu` (originea publică HTTPS, fără cale).
3. În Stripe configurează endpointul `https://www.nova-ai-studio.eu/api/billing/webhook`, cu versiunea API **2024-06-20**, pentru `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated` și `customer.subscription.deleted`. Cererile API ale aplicației folosesc aceeași versiune explicită.
4. Activează Stripe Customer Portal pentru istoricul facturilor, actualizarea metodei de plată și anularea la sfârșitul perioadei. Dezactivează schimbarea planului și a cantității în portal; integrarea acceptă un singur produs/preț.
5. Publică serverul și verifică fluxul în modul Stripe de test: cont vizitator → `/plans.html` → Checkout → webhook semnat → Standard activ cu 300 de cereri. Revenirea la `?checkout=success` singură NU activează planul. Dacă notificarea întârzie, folosește „Verifică abonamentul”.
6. Verifică anularea, plata eșuată și expirarea accesului. Pentru încasări reale, completează verificarea comercială Stripe și contul bancar de decontare, apoi înlocuiește împreună cheia, prețul și secretul webhook cu cele din modul live. Completează datele firmei și obligațiile fiscale înainte de încasări reale; aplicația nu configurează automat taxele.

Accesul plătit și cotele se păstrează în depozitul de conturi existent, inclusiv PostgreSQL dacă acesta este activ. Nu elimina `NOVA_DATA_DIR` sau baza de date la publicare. Webhookurile sunt verificate pe corpul original al cererii; aplicația citește starea curentă a abonamentului și factura plătită din Stripe, prevenind reactivarea pe baza unor evenimente vechi. Checkout reutilizează sesiunile deschise și blochează abonamentele duplicate pentru același cont.

Validare locală: `npm ci` și `npm test`. Testele Stripe folosesc răspunsuri simulate și nu debitează carduri; validarea unei plăți Stripe reale rămâne necesară după configurarea contului.

## Acces la internet în conversații

Chatul și agentul pot folosi `web_search` pentru căutări Bing (RSS, fără cheie API suplimentară) și `read_web_page` pentru citirea textului unei pagini HTTPS publice. Cere, de exemplu: „Caută ultimele noutăți despre Node.js și include sursele” sau „Citește https://nodejs.org/en și rezumă pagina”. Este necesar un model cu suport pentru apelarea uneltelor și un furnizor AI configurat. Răspunsurile trebuie să citeze URL-urile consultate; o eroare de căutare nu este prezentată drept conectare reușită.

Serverul necesită acces DNS și HTTPS direct către `www.bing.com` și site-urile consultate. În medii care permit numai trafic prin proxy, acest transport direct poate fi blocat. Verifică accesul din mediul de producție înainte de a declara funcția disponibilă. Nu este necesară nicio cheie de căutare; disponibilitatea și formatul RSS depind de Bing.

Citirea nu execută JavaScript, nu se autentifică în site-uri și nu citește PDF-uri. Accesul este limitat la HTTPS pe portul 443 și la adrese IPv4 publice; rețelele private, adresele rezervate și redirecționările către ele sunt blocate. Fiecare descărcare are o limită de 1 MiB, 15 secunde și trei redirecționări. Conținutul web este tratat ca informație externă, nu ca instrucțiuni pentru agent. Nu include date private în căutări. Publicarea versiunii actualizate a serverului este necesară pentru activarea funcției pe site-ul online.

Pentru verificare din aplicația publicată, administratorul deschide **Configurare AI → Verifică accesul la internet**. Butonul execută o căutare reală fără apel la model și fără consumarea cotei AI, afișează versiunea serverului și separă accesul web de conexiunea OpenAI/Ollama. Rezultatele sunt păstrate maximum un minut; o căutare fără surse nu este declarată reușită. Răspunsurile XML/HTML/text pot fi comprimate gzip, Brotli sau deflate, cu aceeași limită de 1 MiB după decomprimare.
