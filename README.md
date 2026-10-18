# Nova AI Studio

Nova AI Studio este un studio local de programare asistată de modele Ollama. Această ramură conține aplicația, pagina publică de prezentare și fluxurile GitHub Actions pentru publicarea site-ului și a arhivelor de release.

## Ce publică proiectul

- `site/` — pagină publică cu funcții, cerințe, descărcare și politica de confidențialitate.
- `server.js`, `public/` — aplicația locală Nova AI Studio.
- `.github/workflows/pages.yml` — publică automat `site/` pe GitHub Pages la actualizările din `main`.
- `.github/workflows/release.yml` — creează arhiva aplicației și suma SHA-256 la publicarea unui tag `v*`.

Pagina publică este doar prezentare și distribuție. Aplicația AI nu este expusă pe internet: rulează pe calculatorul utilizatorului, iar modelul este apelat prin Ollama local.

## Pornire locală

1. Instalează Node.js 18+ și Ollama.
2. Pornește Ollama și instalează un model cu suport pentru tool calling, de exemplu `ollama pull qwen3`.
3. Pe Windows, deschide `Start_Nova_AI_Studio.bat`. Pe alte sisteme rulează `npm start`.
4. Deschide `http://127.0.0.1:4173`.

Nu sunt necesare pachete npm. Proiectele se salvează în `projects/`, copiile de rezervă în `data/`, iar conversațiile în profilul browserului. Aceste directoare nu intră în arhiva de release.

## Publicare GitHub

1. Creează repo-ul public `nova-ai-studio` și împinge fișierele acestui director pe ramura `main`.
2. În **Settings → Pages**, selectează **GitHub Actions** ca sursă de publicare.
3. Workflow-ul `Publish website` va publica pagina la `https://adyady0303-hash.github.io/nova-ai-studio/`.
4. Pentru o versiune nouă, actualizează `version` în `package.json`, apoi creează și împinge tag-ul, de exemplu `v0.3.0`. Workflow-ul va publica `Nova-AI-Studio.zip` și `Nova-AI-Studio.zip.sha256` ca assets de release.

Pagina folosește URL-ul „latest release”, așa că butonul de descărcare funcționează după apariția primului release.

## Configurare

- `OLLAMA_URL` — implicit `http://127.0.0.1:11434`.
- `PORT` — implicit `4173`.

Nova nu oferă terminal, nu rulează cod și nu sincronizează proiecte în cloud. Modificările agentului sunt limitate la fișierele proiectului deschis.
