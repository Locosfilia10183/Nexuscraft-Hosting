# NEXUSCRAFT – Hosting Control Plane + Windows/Node Agent

Diese Version erweitert die lokale Node.js-Basis um Modpack-Import, Forge-/NeoForge-Installer, Shop-/Stripe-Grundlage, SMTP-Passwort-Reset, HTTPS-Setup-Skripte und Multi-Node-Pairing.

## 1. Schnellstart (ein PC)

Voraussetzungen:
- Windows Server / Windows 10/11
- Node.js 20+
- Java passend zur Minecraft-Version (für aktuelle MC-Versionen häufig Java 21)
- `tar.exe` (unter aktuellen Windows-Versionen normalerweise enthalten)

Schritte:
1. ZIP in einen neuen Ordner entpacken.
2. `.env.example` nach `.env` kopieren. Für lokalen Start können die externen Schlüssel leer bleiben.
3. `start-all.bat` doppelklicken. Das Skript installiert die Node-Pakete beim ersten Start.
4. Browser: `http://localhost:3000`.
5. Das erste registrierte Konto wird Owner.
6. Agent-Token aus `agent/agent-config.json` geheim halten.

Die Anwendung kann lokal ohne Stripe, SMTP oder CurseForge-Key laufen. Diese Integrationen sind dann deaktiviert und melden klar, welche Konfiguration fehlt.

## 2. Modpack-Installation

### Modrinth
- Im Modpack-Bereich nach Modpacks suchen und sie direkt aus Modrinth auswählen oder eine `.mrpack`-Datei hochladen.
- Im Mods-Bereich Server auswählen.
- Plattform `Modrinth (.mrpack)` auswählen.
- Eine `.mrpack`-Datei hochladen.
- Der Agent prüft ZIP-Pfade gegen Path Traversal, liest `modrinth.index.json`, richtet Minecraft und den Loader ein, lädt die Modrinth-Dateien mit Hashprüfung herunter und kopiert `server-overrides` (bevorzugt) oder `overrides`.
- Vor der Installation wird ein Backup erstellt.
- Unterstützte Loader: Fabric, Forge, NeoForge und Quilt.
- Die bestehende Welt wird nicht absichtlich gelöscht. Der `mods`-Ordner wird ersetzt, um alte Mods nicht in das neue Pack mitzuschleppen.

### CurseForge
- Über die CurseForge-Suche Modpacks finden und die neueste gelistete Datei installieren oder ein CurseForge-Export-ZIP hochladen.
- `CURSEFORGE_API_KEY` muss in `.env` eingetragen sein.
- Die Anwendung liest `manifest.json`, lädt erforderliche Dateien über die CurseForge-API und kopiert `overrides`.
- CurseForge-Downloads können abhängig von Lizenz, Drittanbieter-Freigabe oder API-Antwort nicht verfügbar sein. In diesem Fall wird der konkrete Downloadfehler gemeldet.
- Nicht jedes CurseForge-Client-Exportarchiv enthält einen vollständigen Server-Pack. Bei großen Packs ist ein offizielles Server-Pack vorzuziehen.

### Backups / Rollback
- Vor Modpack-Installation wird ein Server-Backup erstellt.
- Unter „Backups / Versionen anzeigen“ kann ein vorhandenes Backup wiederhergestellt werden.
- Wiederherstellen überschreibt aktuelle Dateien. Der Server muss gestoppt sein.
- Vor jeder Modpack-Aktion zusätzlich eine externe Kopie der Welt behalten.

## 3. Forge und NeoForge

- Bei normaler Serveranlage werden Forge-/NeoForge-Installer automatisch heruntergeladen und mit `--installServer` bzw. `--install-server` ausgeführt.
- Beim Modpack-Import wird die im Modpack angegebene Loader-Version verwendet, soweit sie vom Installer-Repository verfügbar ist.
- Die Start-Argumentdatei wird aus dem erzeugten `run.bat` bzw. den `win_args.txt`-/`unix_args.txt`-Dateien ermittelt.
- Installation benötigt Internetzugriff und genügend freien Speicher.
- Forge-/NeoForge-Installer können sich bei neuen Minecraft-Versionen ändern. Ein realer Starttest mit jeder Modpack-Kombination ist nicht garantiert.

## 4. Shop und Zahlungen (Stripe)

1. Stripe-Konto einrichten.
2. In `.env` `STRIPE_SECRET_KEY` setzen. Zuerst Stripe-Testschlüssel verwenden.
3. In Stripe einen Webhook mit URL `https://DEINE-DOMAIN/api/billing/webhook` einrichten.
4. Mindestens das Event `checkout.session.completed` abonnieren.
5. Webhook-Signatur-Schlüssel in `STRIPE_WEBHOOK_SECRET` eintragen.
6. `PUBLIC_URL` auf die öffentliche HTTPS-Adresse setzen.

Shop-Produkte:
- 1.000 Credits – 4,99 EUR
- 5.000 Credits – 19,99 EUR
- Premium 30 Tage – 4,99 EUR

Gutschrift erfolgt ausschließlich nach erfolgreichem Stripe-Webhook mit gültiger Signatur und `payment_status=paid`. Webhook-Events werden gegen doppelte Verarbeitung abgesichert. Preise sind Beispielpreise und müssen vor dem Verkauf steuerlich/rechtlich geprüft und angepasst werden. Keine Zahlung wird als abgeschlossen angezeigt, bevor Stripe bestätigt.

## 5. Credits für Server-Upgrades

API `POST /api/shop/upgrade`:
- `serverId`
- `ramAdd` in 512-MB-Schritten
- `slotsAdd`

Beispiel-Kosten:
- je 512 MB RAM: 500 Credits
- je 10 Spieler-Slots: 200 Credits

Der Node muss erreichbar sein und der Server muss für RAM-Änderungen gestoppt sein. Credits werden erst nach erfolgreicher Ressourcenänderung abgezogen.

## 6. E-Mail und Passwort-Reset

SMTP-Variablen in `.env`:
- `SMTP_HOST`
- `SMTP_PORT` (typisch 587)
- `SMTP_SECURE` (`true` für implizites TLS, sonst `false` für STARTTLS)
- `SMTP_USER`
- `SMTP_PASS`
- `MAIL_FROM`
- `PUBLIC_URL`

Passwort-Reset ist über „Passwort vergessen?“ im Konto verfügbar. Reset-Tokens sind zufällig, gehasht gespeichert und laufen nach einer Stunde ab. E-Mail-Bestätigung/Verifizierung für neue Konten ist noch nicht aktiviert.

## 7. Öffentliche Domain und HTTPS

1. Domain registrieren.
2. Beim DNS-Anbieter einen A-Record auf die öffentliche IPv4 deines Web-PCs setzen. AAAA nur bei funktionierendem IPv6 setzen.
3. Router und Windows-Firewall müssen TCP 80 und 443 zum Web-PC durchlassen.
4. Caddy installieren.
5. PowerShell als Administrator im Projektordner öffnen:
   `.\setup-public-hosting.ps1 -Domain panel.deine-domain.de -Email admin@deine-domain.de`
6. `PUBLIC_URL=https://panel.deine-domain.de` in `.env` eintragen.
7. Web-App starten und Caddy mit `caddy run --config .\Caddyfile` starten.

Caddy holt und erneuert TLS-Zertifikate automatisch, wenn DNS und Ports korrekt sind. Das Skript kann DNS nicht beim Anbieter verändern; DNS-Zugangsdaten sind providerabhängig und werden nicht erraten.

## 8. Mehrere Hosting-Nodes

Control Plane:
- Ein Owner öffnet Admin → Hosting-Nodes verbinden.
- Pro Node Name, HTTPS-Agent-URL und das geheime Token aus `agent/agent-config.json` eintragen.
- Die Control Plane prüft den `/health`-Endpunkt, bevor der Node gespeichert wird.
- Neue Server werden dem aktuell am wenigsten belegten registrierten Node zugewiesen.
- Server speichern ihre `nodeId`, sodass Start/Stop/Backups/Modpack-Installationen an den richtigen Node gehen.

Node-PC:
1. Projekt/Agent auf dem Node-PC installieren und `npm install` ausführen.
2. Agent mit `npm run start:agent` lokal auf `127.0.0.1:3100` betreiben.
3. Node-Domain auf die öffentliche IPv4 des Node-PCs zeigen lassen.
4. Caddy installieren und als Administrator:
   `.\setup-node-agent-https.ps1 -NodeDomain node01.deine-domain.de -ControlPlanePublicIP 203.0.113.10 -CertificateEmail admin@deine-domain.de`
5. Caddy starten: `caddy run --config .\Caddyfile.node`.
6. Nur die Control-Plane-IP wird von Caddy zum Agent durchgelassen.
7. Im Admin-Bereich `https://node01.deine-domain.de` und den Agent-Token eintragen.

Jeder Node braucht seine eigene Kopie des Agent-Programms und sein eigenes `agent/servers/`- und `agent/backups/`-Verzeichnis. Die Node-Registry liegt in `nodes.json`; sie enthält Agent-Tokens und muss wie ein Passwort geschützt und gesichert werden. `nodes.json` wird nicht in Git aufgenommen.

## 9. Netzwerk / Ports

- Website lokal: TCP 3000 (hinter Caddy nicht öffentlich direkt freigeben).
- Agent lokal: TCP 3100 auf 127.0.0.1 (nicht direkt öffentlich freigeben).
- Minecraft Java: TCP-Port je Server, standardmäßig 25565.
- Bedrock-Crossplay: zusätzlich UDP-Port 19132 bzw. die konfigurierte Geyser-Portnummer.
- Öffentliche DNS- und Routerfreigaben müssen zum jeweiligen Node zeigen.

## 10. Noch nicht vollständig / externe Voraussetzungen

Diese Version ist eine erweiterte technische Basis, kein fertig betriebener kommerzieller Hosting-Dienst:
- CurseForge benötigt einen gültigen API-Key und die Einhaltung der CurseForge-Nutzungs-/Downloadregeln.
- Stripe benötigt ein aktiviertes Händlerkonto, Live-Schlüssel, Webhook und rechtliche Shop-Angaben (Impressum, AGB, Widerruf, Datenschutz, Steuern).
- SMTP benötigt einen echten Mailanbieter und DNS-Einträge wie SPF, DKIM und DMARC.
- DNS-Records werden nicht automatisch beim Provider geändert.
- Caddy kann HTTPS-Zertifikate beziehen, aber öffentliche Erreichbarkeit, Router, Firewall und Domain müssen stimmen.
- Multi-Node verteilt neu angelegte Server auf Nodes. Bestehende Server werden nicht automatisch migriert; Ressourcen-Pooling, Live-Migration, Cluster-Scheduling, Node-Drain und automatische Failover-Replikation sind nicht enthalten.
- Es gibt keinen vollständigen DDoS-Schutz, keine zentrale Datenbank-Replikation und keine Hochverfügbarkeitsgarantie.
- E-Mail-Verifizierung, 2FA, automatisierte Rechnungs-/Steuerbelege, vollständige AGB-/DSGVO-Prozesse und Zahlungsrückerstattungen sind noch nicht umgesetzt.
- CPU-Messung ist eine Momentaufnahme/Schätzung aus Prozesszeit; Spielerverlauf wird alle 30 Sekunden aus echten Server-`list`-Antworten gesammelt. Große Datei-Uploads/Downloads bis 100 MB sind über die Serverkarten möglich. Eine vollständige grafische Langzeitanalyse und automatische Modpack-Kompatibilitätsprüfung fehlen weiterhin.
- Bedrock-only Server werden durch diese Java-Agent-Installer nicht bereitgestellt.
- Keine echte Minecraft-Modpack-Installation, Stripe-Livezahlung, SMTP-Mailzustellung oder öffentliche DNS-/HTTPS-Verbindung konnte in dieser Entwicklungsumgebung Ende-zu-Ende getestet werden.

## 11. Sicherheit und Daten

- `data.json`, `nodes.json`, `.env`, `agent/agent-config.json` enthalten sensible Daten.
- Diese Dateien niemals in öffentliche Repositories oder Chats hochladen.
- Vor Upgrade folgende Daten sichern: `data.json`, `nodes.json`, `.env`, `agent/agent-config.json`, `agent/servers.json`, `agent/servers/`, `agent/backups/`.
- Die ZIP enthält keine Zugangsschlüssel. Externe Integrationen bleiben ohne eigene Schlüssel deaktiviert.
