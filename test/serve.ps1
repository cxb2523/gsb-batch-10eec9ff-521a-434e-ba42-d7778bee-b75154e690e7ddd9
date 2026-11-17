# Minimal static file server for the Scritch player test harness (no external deps).
# Serves the repo root over http://127.0.0.1:<Port>/ and accepts POST /__results
# to persist the test harness output to test\results.txt.
param(
    [int]$Port = 8321,
    [string]$Root = (Split-Path -Parent $PSScriptRoot)
)

$mime = @{
    '.html'  = 'text/html; charset=utf-8'
    '.js'    = 'text/javascript'
    '.json'  = 'application/json'
    '.css'   = 'text/css'
    '.wav'   = 'audio/wav'
    '.mp3'   = 'audio/mpeg'
    '.png'   = 'image/png'
    '.jpg'   = 'image/jpeg'
    '.svg'   = 'image/svg+xml'
    '.woff'  = 'font/woff'
    '.woff2' = 'font/woff2'
    '.ttf'   = 'font/ttf'
    '.eot'   = 'application/vnd.ms-fontobject'
    '.txt'   = 'text/plain'
    '.md'    = 'text/plain'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()
Write-Host "serving $Root at http://127.0.0.1:$Port/"

while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    try {
        $req = $ctx.Request
        $res = $ctx.Response
        $path = $req.Url.LocalPath

        if ($path -eq '/__results' -and $req.HttpMethod -eq 'POST') {
            $reader = New-Object System.IO.StreamReader($req.InputStream, $req.ContentEncoding)
            $body = $reader.ReadToEnd()
            $reader.Close()
            [System.IO.File]::WriteAllText((Join-Path $PSScriptRoot 'results.txt'), $body)
            $buf = [System.Text.Encoding]::UTF8.GetBytes('ok')
            $res.ContentType = 'text/plain'
            $res.ContentLength64 = $buf.Length
            $res.OutputStream.Write($buf, 0, $buf.Length)
            $res.Close()
            continue
        }

        if ($path -eq '/') { $path = '/index.html' }
        $file = Join-Path $Root ($path.TrimStart('/').Replace('/', [System.IO.Path]::DirectorySeparatorChar))
        if (Test-Path $file -PathType Leaf) {
            $bytes = [System.IO.File]::ReadAllBytes($file)
            $ext = [System.IO.Path]::GetExtension($file).ToLower()
            $res.ContentType = $mime[$ext]
            if (-not $res.ContentType) { $res.ContentType = 'application/octet-stream' }
            $res.ContentLength64 = $bytes.Length
            $res.OutputStream.Write($bytes, 0, $bytes.Length)
        } else {
            $res.StatusCode = 404
            $buf = [System.Text.Encoding]::UTF8.GetBytes('not found')
            $res.ContentLength64 = $buf.Length
            $res.OutputStream.Write($buf, 0, $buf.Length)
        }
        $res.Close()
    } catch {
        Write-Host "request error: $_"
    }
}
