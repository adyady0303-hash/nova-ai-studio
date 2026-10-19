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

Pagina de autentificare permite vizitatorilor să-și creeze conturi separate de abonat. Proiectele lor sunt private, iar administratorul păstrează spațiul și setările AI existente. Un cont de abonat are implicit 20 de cereri AI pe zi și cel mult 10 proiecte; apelurile folosesc furnizorul AI configurat de administrator și pot avea costuri.

### Deploy cu Docker

1. Instalează Docker cu suport pentru Compose.
2. Copiază `.env.example` în `.env` și setează o parolă aleatoare de cel puțin 20 de caractere. Adaugă cheia furnizorului AI în `.env` sau lasă cheia necompletată și configureaz-o din fereastra Nova.
3. Din directorul proiectului rulează `docker compose up -d --build`.
4. Deschide `http://localhost:4173`. Pentru expunere pe internet, pune containerul în spatele unui proxy HTTPS (de exemplu Caddy) și păstrează autentificarea pornită.

Volumul Docker `nova-data` păstrează proiectele și copiile de rezervă la repornire. Fără un disk persistent montat, datele locale ale unui serviciu cloud pot dispărea la redeploy.

## Pornire locală pe Windows

1. Instalează Node.js 18+ și pornește Ollama.
2. Rulează `ollama pull qwen3` sau descarcă un alt model local cu tool calling.
3. Deschide `Start_Nova_AI_Studio.bat`. Nova caută un port liber între 4173 și 4190.
4. În Nova, deschide **Configurare AI** și selectează Ollama sau un endpoint cloud.

Nu sunt necesare pachete npm. Proiectele și backup-urile rămân în dosarul aplicației când rulezi local.

## Configurare server

| Variabilă | Scop |
| --- | --- |
| `HOST` / `PORT` | Adresa și portul serverului. Pentru publicare folosește `0.0.0.0` și portul dat de hosting. |
| `NOVA_ACCESS_USER` / `NOVA_ACCESS_PASSWORD` | Autentificare prin formular Nova și cookie de sesiune `HttpOnly`, `Secure` și `SameSite`; parola trebuie să aibă cel puțin 20 de caractere pe host public. |
| `NOVA_DATA_DIR` | Rădăcina proiectelor, backup-urilor și coșului de gunoi. Montează aici storage persistent. |
| `NOVA_MAX_ACCOUNTS` | Numărul maxim de conturi de abonat; implicit `100`. |
| `NOVA_SUBSCRIBER_DAILY_AI_LIMIT` | Cereri AI permise zilnic fiecărui abonat; implicit `20`. |
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
