param(
    [string]$OutputPath = (Join-Path $PSScriptRoot 'OpenCodeTailnetLauncher.ico')
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

function New-IconPngBytes {
    param([int]$Size)

    $bmp = New-Object System.Drawing.Bitmap $Size, $Size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    $rect = New-Object System.Drawing.RectangleF ($Size * 0.08), ($Size * 0.08), ($Size * 0.84), ($Size * 0.84)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $r = [single]($Size * 0.22)
    $d = $r * 2
    $path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
    $path.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
    $path.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
    $path.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
    $path.CloseFigure()

    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.Point -ArgumentList 0, 0),
        (New-Object System.Drawing.Point -ArgumentList $Size, $Size),
        ([System.Drawing.Color]::FromArgb(255, 61, 140, 255)),
        ([System.Drawing.Color]::FromArgb(255, 20, 46, 94))
    )
    $g.FillPath($brush, $path)

    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(210, 211, 227, 255)), ([single]($Size * 0.035))
    $g.DrawPath($pen, $path)

    $font = New-Object System.Drawing.Font('Segoe UI Semibold', ($Size * 0.34), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $fmt = New-Object System.Drawing.StringFormat
    $fmt.Alignment = [System.Drawing.StringAlignment]::Center
    $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
    $shadow = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(70, 0, 0, 0))
    $text = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 243, 248, 255))
    $textRect = New-Object System.Drawing.RectangleF 0, ($Size * -0.02), $Size, $Size
    $shadowRect = New-Object System.Drawing.RectangleF ($Size * 0.012), ($Size * -0.008), $Size, $Size
    $g.DrawString('OC', $font, $shadow, $shadowRect, $fmt)
    $g.DrawString('OC', $font, $text, $textRect, $fmt)

    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)

    $brush.Dispose()
    $pen.Dispose()
    $font.Dispose()
    $shadow.Dispose()
    $text.Dispose()
    $fmt.Dispose()
    $path.Dispose()
    $g.Dispose()
    $bmp.Dispose()

    return ,$ms.ToArray()
}

$sizes = @(16, 32, 48, 64, 256)
$images = @()
foreach ($size in $sizes) {
    $images += [pscustomobject]@{ Size = $size; Bytes = (New-IconPngBytes -Size $size) }
}

$dir = Split-Path -Parent $OutputPath
if ($dir) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
}

$fs = [System.IO.File]::Open($OutputPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
$bw = New-Object System.IO.BinaryWriter($fs)

$bw.Write([UInt16]0)
$bw.Write([UInt16]1)
$bw.Write([UInt16]$images.Count)

$offset = 6 + (16 * $images.Count)
foreach ($img in $images) {
    $dim = if ($img.Size -ge 256) { 0 } else { [byte]$img.Size }
    $bw.Write([byte]$dim)
    $bw.Write([byte]$dim)
    $bw.Write([byte]0)
    $bw.Write([byte]0)
    $bw.Write([UInt16]1)
    $bw.Write([UInt16]32)
    $bw.Write([UInt32]$img.Bytes.Length)
    $bw.Write([UInt32]$offset)
    $offset += $img.Bytes.Length
}

foreach ($img in $images) {
    $bw.Write($img.Bytes)
}

$bw.Flush()
$bw.Dispose()
$fs.Dispose()

Write-Host "Generated $OutputPath"
