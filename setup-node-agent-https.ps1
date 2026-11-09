param(
 [Parameter(Mandatory=$true)][string]$NodeDomain,
 [Parameter(Mandatory=$true)][string]$ControlPlanePublicIP,
 [Parameter(Mandatory=$true)][string]$CertificateEmail,
 [string]$CaddyExe="caddy.exe",
 [int]$AgentPort=3100
)
$ErrorActionPreference="Stop"
if (!(Get-Command $CaddyExe -ErrorAction SilentlyContinue)) { throw "Caddy nicht gefunden. Caddy installieren und in PATH aufnehmen." }
$cfg = @"
{
 email $CertificateEmail
}
$NodeDomain {
 @blocked not remote_ip $ControlPlanePublicIP
 respond @blocked 403
 reverse_proxy 127.0.0.1:$AgentPort
}
"@
[System.IO.File]::WriteAllText((Join-Path (Get-Location) "Caddyfile.node"), $cfg, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Lege beim DNS-Anbieter einen A-Record für $NodeDomain auf die öffentliche IPv4 dieses Nodes."
Write-Host "Öffne TCP 80 und 443 in Firewall/Router und starte den Agent lokal auf 127.0.0.1:$AgentPort."
Write-Host "Der Reverse Proxy lässt nur die Control-Plane-IP $ControlPlanePublicIP zu."
& $CaddyExe validate --config .\Caddyfile.node
Write-Host "Start: caddy run --config .\Caddyfile.node"
