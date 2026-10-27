# gvv – Grundversicherungsvergleich

Kleine Web-App für den eigenen Haushalt: vergleicht jedes Jahr die offiziellen Prämien der
obligatorischen Krankenpflegeversicherung (Grundversicherung) und bereitet einen Wechsel vor.

- Lädt die Prämiendaten des Bundesamts für Gesundheit (opendata.swiss / priminfo.admin.ch) selbst und
  prüft jede Nacht, ob neue Daten da sind (die Prämien fürs Folgejahr erscheinen jeweils Ende September).
- Pro Person: Wohngemeinde (bestimmt die Prämienregion), Jahrgang, Franchise, Unfall, erlaubte Modelle,
  aktuelle Kasse und Produkt, ausgeschlossene Kassen oder Produkte.
- Rangliste der günstigsten passenden Angebote und ein Vorschlag (wechseln ab einer einstellbaren Ersparnis).
- Nach dem Entscheid: Kündigungsbrief (bzw. Brief für einen Modellwechsel bei der gleichen Kasse),
  Datenblatt für den Antrag bei der neuen Kasse und eine Checkliste bis zur neuen Police.
- Web-Push-Erinnerungen vor der Kündigungsfrist (30. November) und zum Nachfassen im Dezember.
- Es wird nichts automatisch verschickt. Briefe druckt und verschickt man selbst.
- Mandantenfähig: Jeder Benutzer sieht und bearbeitet nur die Personen, die er selbst erfasst hat. Absenderadresse,
  Wechselschwelle und Erinnerungen gelten ebenfalls pro Benutzer. Gemeinsam sind nur die BAG-Prämiendaten und die
  hinterlegten Kündigungsadressen der Kassen.

Keine externen Abhängigkeiten (Node 24: `node:http`, `node:sqlite`, `node:crypto`).

## Konfiguration

| Variable | Beispiel | Zweck |
|---|---|---|
| `PUBLIC_URL` | `https://gvv.example.com` | Öffentliche Adresse (für Login-Redirect und Cookies) |
| `ALLOWED_USERS` | `alex:alex@example.com,sam:sam@example.com` | Wer sich mit Google anmelden darf |
| `USER_NAMES` | `alex:Alex,sam:Sam` | Anzeigenamen |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | | OAuth-Client (Web), Redirect-URI `PUBLIC_URL/auth/callback` |
| `GITHUB_REPO`, `GITHUB_REF` | `owner/gvv`, `main` | Woher der Container den Code holt |
| `BIND_ADDR`, `HOST_PORT` | `0.0.0.0`, `8080` | Port auf dem Docker-Host (hinter einem Reverse-Proxy) |
| `AUTO_IMPORT` | `1` | `0` schaltet den automatischen BAG-Import ab |

Die Daten liegen in einer SQLite-Datei im Volume (`/home/node/data/gvv.db`).

## Lokal testen

```sh
DEV_LOGIN=1 ALLOWED_USERS=test:test@example.com node server.js
# dann http://localhost:8080/auth/dev?u=test öffnen
```

## Hinweise zur Grundversicherung

- Bei einer Prämienänderung kann die Grundversicherung mit einem Monat Frist auf Ende Jahr gekündigt werden:
  Die Kündigung muss bis 30. November beim Versicherer sein (Art. 7 Abs. 2 KVG). Am besten eingeschrieben.
- Die Kündigung wird erst wirksam, wenn der neue Versicherer die Aufnahme bestätigt hat.
- Die Grundversicherung muss jede Person ohne Gesundheitsfragen aufnehmen. Zusatzversicherungen sind davon unabhängig.
- Die Adresse aus dem BAG-Verzeichnis ist der Hauptsitz. Viele Kassen nennen für Kündigungen eine andere
  Postadresse; diese lässt sich in der App pro Kasse hinterlegen.
