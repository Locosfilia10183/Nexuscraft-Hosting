param(
 [Parameter(Mandatory=$true)][string]$Domain,
 [Parameter(Mandatory=$true)][string]$Email,
 [string]$CaddyExe="caddy.exe",
 [int]$WebPort=3000
)
$ErrorActionPreference="Stop"
if ($Domain -notmatch '^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$') { throw "Ungültige Domain" }
if (!(Get-Command $CaddyExe -ErrorAction SilentlyContinue)) { throw "Caddy nicht gefunden. Caddy installieren und in PATH aufnehmen." }
$cfg = @"
{
 email $Email
}
$Domain {
 encode zstd gzip
 reverse_proxy 127.0.0.1:$WebPort
}
"@
[System.IO.File]::WriteAllText((Join-Path (Get-Location) "Caddyfile"), $cfg, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Caddyfile erstellt."
Write-Host "WICHTIG: Lege beim DNS-Anbieter einen A-Record für $Domain auf die öffentliche IPv4 deines Servers."
Write-Host "Optional AAAA-Record nur setzen, wenn IPv6 wirklich erreichbar ist."
Write-Host "Öffne TCP 80 und 443 in Firewall/Router. Leite TCP 80/443 auf diesen PC."
Write-Host "Stelle sicher, dass PUBLIC_URL=https://$Domain in .env steht und Node.js auf Port $WebPort läuft."
Write-Host "Starte Caddy mit: caddy run --config .\Caddyfile"
& $CaddyExe validate --config .\Caddyfile
