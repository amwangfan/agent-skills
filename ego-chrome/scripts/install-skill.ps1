$ErrorActionPreference = 'Stop'

$Source = (Resolve-Path (Join-Path $PSScriptRoot '..\skills\ego-chrome')).Path
$SkillRoot = if ($env:AGENTS_HOME) {
    Join-Path $env:AGENTS_HOME 'skills'
} else {
    Join-Path $HOME '.agents\skills'
}
$Destination = Join-Path $SkillRoot 'ego-chrome'

New-Item -ItemType Directory -Force -Path $SkillRoot | Out-Null
if (Test-Path $Destination) {
    Remove-Item -Recurse -Force $Destination
}
Copy-Item -Recurse -Force $Source $Destination

Write-Host "Installed ego-chrome skill to $Destination"
Write-Host 'Restart Codex so it discovers the skill.'
