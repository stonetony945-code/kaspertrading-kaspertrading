# Desktop notification for a monitor alert.
#
# The monitor previously "alerted" by writing a line to a file and printing a
# banner into a console nobody watches, since it runs as a scheduled task. Three
# signals fired on 2026-09-02 and the user learned of them hours later. This is
# the missing channel.
#
#   .\notify.ps1 -Title "SIGNAL BAISSIER GBPUSD" -Message "1.35009 — K77/D80"
#
# Toast first, sound always: the toast API is version-dependent and can fail
# quietly, and an alert you might not see is the problem being fixed here.

param(
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][string]$Message
)

$ErrorActionPreference = 'Continue'

# Audible first, so the alert lands even if every visual path fails.
try {
    [System.Media.SystemSounds]::Exclamation.Play()
    Start-Sleep -Milliseconds 250
    [console]::beep(880, 200)
    [console]::beep(660, 300)
} catch { }

# Windows toast. Uses the built-in WinRT bridge rather than a module so there is
# nothing to install; wrapped because the API differs across builds.
$toastOk = $false
try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
        [Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    $texts = $template.GetElementsByTagName('text')
    $texts.Item(0).AppendChild($template.CreateTextNode($Title)) | Out-Null
    $texts.Item(1).AppendChild($template.CreateTextNode($Message)) | Out-Null
    $toast = [Windows.UI.Notifications.ToastNotification]::new($template)
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('KasperTrading').Show($toast)
    $toastOk = $true
} catch { }

# Tray balloon as the fallback: older API, but it works where the toast bridge
# does not.
if (-not $toastOk) {
    try {
        Add-Type -AssemblyName System.Windows.Forms
        $icon = New-Object System.Windows.Forms.NotifyIcon
        $icon.Icon = [System.Drawing.SystemIcons]::Warning
        $icon.Visible = $true
        $icon.ShowBalloonTip(20000, $Title, $Message, [System.Windows.Forms.ToolTipIcon]::Warning)
        Start-Sleep -Seconds 12
        $icon.Dispose()
    } catch { }
}
