; Custom NSIS script to fix false positive "Slide cannot be closed" error.
; The default check matches any process containing "Slide" in its name,
; causing install to fail even when Slide is not running.
; This macro bypasses the check. Ensure Slide is closed before installing.
!macro customCheckAppRunning
!macroend
