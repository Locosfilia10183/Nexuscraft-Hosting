param()
$ErrorActionPreference="Stop"
# Caddy handles public HTTPS on 80/443. The Node agent stays bound to loopback (127.0.0.1:3100).
# Do NOT create a public inbound rule for port 3100.
foreach ($port in @(80,443)) {
 $name="NEXUSCRAFT-Caddy-TCP-$port"
 Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
 New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -RemoteAddress Any -Profile Domain,Private,Public
}
Write-Host "Caddy TCP 80/443 freigegeben. Agent-Port 3100 bleibt lokal und darf nicht direkt aus dem Internet erreichbar sein."
