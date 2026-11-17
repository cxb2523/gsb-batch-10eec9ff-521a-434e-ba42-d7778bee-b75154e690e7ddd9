# Generates small PCM WAV files used by the test harness (no external deps).
param([string]$OutDir = (Join-Path $PSScriptRoot 'media'))

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function Write-Wav {
    param([string]$Path, [double]$Seconds, [double]$Freq = 440.0)
    $rate = 8000
    $bits = 16
    $channels = 1
    $blockAlign = $channels * ($bits / 8)
    $byteRate = $rate * $blockAlign
    $numSamples = [int]($rate * $Seconds)
    $dataSize = $numSamples * $blockAlign

    $fs = [System.IO.File]::Create($Path)
    $bw = New-Object System.IO.BinaryWriter($fs)
    try {
        $bw.Write([System.Text.Encoding]::ASCII.GetBytes('RIFF'))
        $bw.Write([uint32](36 + $dataSize))
        $bw.Write([System.Text.Encoding]::ASCII.GetBytes('WAVE'))
        $bw.Write([System.Text.Encoding]::ASCII.GetBytes('fmt '))
        $bw.Write([uint32]16)              # fmt chunk size
        $bw.Write([uint16]1)               # PCM
        $bw.Write([uint16]$channels)
        $bw.Write([uint32]$rate)
        $bw.Write([uint32]$byteRate)
        $bw.Write([uint16]$blockAlign)
        $bw.Write([uint16]$bits)
        $bw.Write([System.Text.Encoding]::ASCII.GetBytes('data'))
        $bw.Write([uint32]$dataSize)
        for ($i = 0; $i -lt $numSamples; $i++) {
            $t = $i / $rate
            $sample = [int16]([Math]::Sin(2 * [Math]::PI * $Freq * $t) * 12000)
            $bw.Write($sample)
        }
    } finally {
        $bw.Close()
        $fs.Close()
    }
    Write-Host "wrote $Path ($Seconds s)"
}

Write-Wav (Join-Path $OutDir 'loop1.wav')  6 440
Write-Wav (Join-Path $OutDir 'plain1.wav') 6 330
Write-Wav (Join-Path $OutDir 'drag1.wav')  6 440
Write-Wav (Join-Path $OutDir 'drag2.wav')  6 550
Write-Wav (Join-Path $OutDir 'ok1.wav')    4 440
Write-Wav (Join-Path $OutDir 'ok2.wav')    5 660
