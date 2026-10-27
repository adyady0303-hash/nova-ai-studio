# Publicare Android și iOS

Nova AI Studio 2.3.1 folosește Capacitor și deschide exclusiv platforma HTTPS de la `https://www.nova-ai-studio.eu`. Identificatorul ambelor aplicații este `eu.nova.ai.studio`.

## Verificare locală

```bash
npm ci
npm test
npm run mobile:sync
npm run mobile:build:android
```

APK-ul de test este creat în `android/app/build/outputs/apk/debug/app-debug.apk`. Pachetul AAB din `android/app/build/outputs/bundle/release/app-release.aab` rămâne nesemnat până când este configurată cheia privată a proprietarului.

## Google Play

1. Creează aplicația `Nova AI Studio` cu package ID `eu.nova.ai.studio` în contul Google Play Console al proprietarului.
2. Activează Play App Signing și generează cheia de încărcare într-un mediu privat. Fișierele `.jks` și `.keystore` sunt ignorate de Git.
3. Configurează semnarea `release` local sau în sistemul CI cu secrete protejate, reconstruiește AAB-ul și încarcă-l mai întâi într-un canal de testare internă.
4. Completează politica de confidențialitate, secțiunea Data safety, clasificarea conținutului, capturile de ecran și datele de contact, apoi promovează versiunea în producție după aprobarea Google.

## App Store

1. În Xcode, deschide `ios/App/App.xcodeproj`, alege echipa Apple Developer a proprietarului și păstrează bundle ID `eu.nova.ai.studio`.
2. Creează în App Store Connect aplicația cu același bundle ID, arhivează configurația Release și trimite buildul prin Xcode Organizer.
3. Completează App Privacy, politica de confidențialitate, capturile, categoria și datele de contact și trimite versiunea spre review.

Semnarea și publicarea în magazine nu pot fi efectuate fără accesul proprietarului la conturile Google Play și Apple Developer. Nu salva parole, certificate sau chei private în repository.
