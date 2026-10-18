# Nova AI Studio

Nova AI Studio este un studio local pentru cod și creație asistată de modele Ollama. Același chat ajută la aplicații pentru Windows/PC, versuri originale, planuri de compoziție muzicală și scenarii/storyboard-uri video. Aplicația poate scrie cod și fișiere text în proiectul local atunci când utilizatorul permite.

Ollama furnizează text și specificații. În browser, Nova poate sintetiza o melodie simplă fără voce în WAV și poate exporta un videoclip tipografic cu scene colorate în WebM. Aceste funcții nu generează voci cântate, imagini sau filmări; exporturile MP3/MP4 și media fotorealistă cer motoare externe.

## Ce publică proiectul

- `site/` — pagină publică cu funcții, cerințe, descărcare și politica de confidențialitate.
- `server.js`, `public/` — aplicația locală Nova AI Studio.
- `.github/workflows/pages.yml` — publică automat `site/` pe GitHub Pages la actualizările din `main`.
- `.github/workflows/release.yml` — creează arhiva aplicației și suma SHA-256 la publicarea unui tag `v*`.

Pagina publică este doar prezentare și distribuție. Aplicația AI nu este expusă pe internet: rulează pe calculatorul utilizatorului, iar modelul este apelat prin Ollama local.

## Pornire locală

1. Instalează Node.js 18+ și Ollama.
2. Pornește Ollama și instalează un model cu suport pentru tool calling, de exemplu `ollama pull qwen3`.
3. Pe Windows, deschide `Start_Nova_AI_Studio.bat`. Scriptul redeschide Nova v0.5.0 dacă rulează deja; altfel caută un port liber între 4173 și 4190 și pornește versiunea nouă acolo.
4. Deschide `http://127.0.0.1:4173`.

În chat, selectează automat, cod Windows/PC, versuri, compoziție muzicală sau scenariu video. Răspunsurile de muzică au buton de export WAV, iar scenele video pot fi randate în WebM. Pentru a salva fișiere în proiect, activează „Permite agentului să scrie fișiere în proiect”.

Nu sunt necesare pachete npm. Proiectele se salvează în `projects/`, copiile de rezervă în `data/`, iar conversațiile în profilul browserului. Aceste directoare nu intră în arhiva de release.

## Publicare GitHub

1. Creează repo-ul public `nova-ai-studio` și împinge fișierele acestui director pe ramura `main`.
2. Workflow-ul `Publish website` activează GitHub Pages cu sursa GitHub Actions și publică pagina la `https://adyady0303-hash.github.io/nova-ai-studio/`.
3. Pentru o versiune nouă, actualizează `version` în `package.json`, apoi pornește manual workflow-ul `Build and publish Nova release` cu tag-ul (de exemplu `v0.3.0`) sau împinge un tag `v*`. Workflow-ul publică `Nova-AI-Studio.zip` și `Nova-AI-Studio.zip.sha256` ca assets de release.

Arhiva publică v0.5.0 este păstrată în `downloads/Nova-AI-Studio-v0.5.0.zip`, iar suma de verificare lângă ea. Pagina publică trimite direct la această arhivă.

## Configurare

- `OLLAMA_URL` — implicit `http://127.0.0.1:11434`.
- `PORT` — implicit `4173`; dacă portul este ocupat de alt serviciu, setează o valoare liberă, de exemplu `4174`.

Nova nu oferă terminal, nu rulează cod și nu sincronizează proiecte în cloud. Modificările agentului sunt limitate la fișierele proiectului deschis.

