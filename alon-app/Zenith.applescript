-- The Zenith Mac app's window. alon-release.sh builds Zenith.app from this
-- with osacompile and puts launcher.sh, the Node it runs on and Zenith's code
-- in the app's Resources. The window says Zenith is running, with Open and
-- Stop; quitting the app stops Zenith too.

on launcher(action)
	set launcherPath to (POSIX path of (path to me)) & "Contents/Resources/launcher.sh"
	return do shell script "/bin/zsh " & quoted form of launcherPath & " " & action
end launcher

on run
	try
		set said to launcher("start")
	on error message
		display dialog message buttons {"OK"} default button "OK" with title "Zenith" with icon caution
		return
	end try
	-- Another Zenith already runs on this Mac: it was opened; nothing to stop here.
	if said is "elsewhere" then return
	-- Look for an update in the background; the window shows it once it is ready.
	do shell script "/bin/zsh " & quoted form of ((POSIX path of (path to me)) & "Contents/Resources/launcher.sh") & " check-bg > /dev/null 2>&1 &"
	try
		repeat
			set updateNote to launcher("note")
			set ready to updateNote contains "READY "
			set shown to my withoutMarker(updateNote)
			set message to "Zenith is running. It opened in your browser at localhost:4173." & return & return & "Stop it here, or quit this app." & shown
			if ready then
				set reply to display dialog message buttons {"Stop", "Restart now", "Open"} default button "Open" with title "Zenith" giving up after 21600
			else
				set reply to display dialog message buttons {"Stop", "Open"} default button "Open" with title "Zenith" giving up after 21600
			end if
			if gave up of reply then
				-- Six hours on: look for an update again.
				do shell script "/bin/zsh " & quoted form of ((POSIX path of (path to me)) & "Contents/Resources/launcher.sh") & " check-bg > /dev/null 2>&1 &"
			else if button returned of reply is "Open" then
				launcher("open")
			else if button returned of reply is "Restart now" then
				launcher("restart")
			else
				launcher("stop")
				return
			end if
		end repeat
	on error message number code
		-- Quitting the app (or closing the window) stops Zenith.
		launcher("stop")
		if code is not -128 then display dialog message buttons {"OK"} default button "OK" with title "Zenith" with icon caution
	end try
end run

on quit
	try
		launcher("stop")
	end try
	continue quit
end quit

-- The note without its READY marker, on its own lines.
on withoutMarker(updateNote)
	if updateNote is "" then return ""
	set AppleScript's text item delimiters to "READY "
	set parts to text items of updateNote
	set AppleScript's text item delimiters to ""
	return return & return & (parts as text)
end withoutMarker
