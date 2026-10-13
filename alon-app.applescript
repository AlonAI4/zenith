-- Zenith launcher (Alon's build of God's Eye View). Build it with:
--   osacompile -o ~/Applications/Zenith.app alon-app.applescript
-- First run starts the app and opens it. Run it again while it is running to
-- open it, update it or stop it.
on helper(action)
	set projectDir to (POSIX path of (path to home folder)) & "tools/zenith"
	return do shell script "/bin/zsh " & quoted form of (projectDir & "/alon-app.sh") & " " & action
end helper

try
	if helper("status") is "running" then
		set choice to button returned of (display dialog "Zenith is running." buttons {"Stop", "Update", "Open"} default button "Open" with title "Zenith")
		if choice is "Open" then
			helper("start")
		else if choice is "Stop" then
			helper("stop")
		else
			-- Nothing is installed unread: first say what the update is, then ask.
			display notification "Checking the original project for updates…" with title "Zenith"
			set preview to helper("update-preview")
			if preview contains "ID: " then
				set updateId to last word of preview
				set answer to button returned of (display dialog preview buttons {"Not now", "Install"} default button "Not now" with title "Zenith update")
				if answer is "Install" then
					display notification "Installing, then testing every add-on. This takes about ten minutes." with title "Zenith"
					set report to helper("update-install " & quoted form of updateId)
					display dialog report buttons {"OK"} default button "OK" with title "Zenith update"
				end if
			else
				display dialog preview buttons {"OK"} default button "OK" with title "Zenith update"
			end if
		end if
	else
		display notification "Starting…" with title "Zenith"
		helper("start")
	end if
on error message number code
	if code is not -128 then display dialog message buttons {"OK"} default button "OK" with title "Zenith" with icon caution
end try
