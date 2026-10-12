-- Zenith launcher (Alon's build of God's Eye View). Build it with:
--   osacompile -o ~/Applications/Zenith.app alon-app.applescript
-- First run starts the app and opens it. Run it again while it is running to
-- open it, update it or stop it.
on helper(action)
	set projectDir to (POSIX path of (path to home folder)) & "tools/gods-eye-view"
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
			display notification "Downloading the newest version and running the tests. This takes a minute or two." with title "Zenith"
			set report to helper("update")
			display dialog report buttons {"OK"} default button "OK" with title "Zenith update"
		end if
	else
		display notification "Starting…" with title "Zenith"
		helper("start")
	end if
on error message number code
	if code is not -128 then display dialog message buttons {"OK"} default button "OK" with title "Zenith" with icon caution
end try
