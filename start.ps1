param([switch]$LocalKev,[switch]$LocalEmbeddings,[switch]$NoPrompt)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
& 'E:\DEV\Projects\MythEngine-runtime\Start-MythEngine.ps1' @PSBoundParameters -OpenBrowser
