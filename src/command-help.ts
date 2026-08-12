// Generated help text for `amux --help`.
// Regenerate with: bun run build:help
// When adding/changing commands, update this file to match.
export const HELP_TEXT = `usage: amux <command> [args] [--flag=value] [--session=<id>]
       amux <command> [args] \\; <command> [args] ...
       amux agent-state --state <idle|working|blocked|failed|done>
       amux agent-hook opencode <install|uninstall> --yes

Commands:
  agents:
    agent.new [harness] [cmd] [prompt]
        start a coding agent
    agent.prompt [session] <target> <text> [wait] [until] [timeout]
        send a prompt to an agent; optionally wait for its anchored lifecycle
    agent.watch [session] <target> [after]
        stream durable agent events as JSON lines
    agent.interrupt [session] [reason]
        interrupt an agent turn
    agent.permission [session] <request> <decision> [feedback]
        answer an agent's permission request
  buffers:
    buffer.set [name] <data>
        set a paste buffer (a copy pushes onto the stack automatically)
    buffer.list
        list the paste buffers
    buffer.delete [name]
        delete the top paste buffer (or a named one)
    buffer.show [name]
        show a paste buffer's contents
  global:
    app.quit
        quit
  notifications:
    notify <title> <body> [session]
        send a notification to a session
  panes:
    pane.split <axis>
        split the focused pane
    pane.next
        focus the next pane
    pane.last
        toggle to the last-focused pane
    pane.focus <direction>
        focus the pane in a direction
    pane.select <pane>
        focus a pane by id
    pane.resize <direction>
        resize the focused pane
    pane.resize-divider <path> <index> <delta>
        move a layout divider
    pane.zoom
        zoom the focused pane
    pane.float
        toggle the focused pane between floating and tiled
    pane.swap <to>
        swap the focused pane with its neighbour
    pane.close
        close the focused pane and stop its backend if it has no other view
    pane.break
        break the focused pane into its own window
    pane.join [source]
        join a pane from another window into the focused window
    pane.move <space>
        move the focused pane into another space
    pane.send-keys <keys>
        send keys to the focused pane
    pane.capture [session]
        capture the focused pane
  plugins:
    plugin.enable <plugin>
        enable a plugin in this client
    plugin.disable <plugin>
        disable a plugin in this client
    plugin.reload [plugin]
        load a plugin's source again; all of them if none is named
  sessions:
    session.kill [session]
        stop a session
    session.restart [session]
        restart an exited session
    session.reveal <session>
        show and focus a session
    session.next-blocked
        select the next blocked session
  spaces:
    space.new [name] [dir] [branch] [base]
        new space
    space.select <space>
        select a space by id
    space.rename [space] <name>
        rename a space
    space.close [space]
        close a space and everything in it
    space.next
        next space
    space.previous
        previous space
  windows:
    window.new
        new window
    window.next
        next window
    window.previous
        previous window
    window.last
        toggle to the last window
    window.select [space] <number>
        select a window by its number
    window.rename [space] [window] <name>
        rename a window; an empty name restores the running command's title
    window.close [space] [window]
        kill a window and its agents
    window.next-layout
        cycle through the preset layouts
    window.select-layout <preset>
        arrange panes in a preset layout
    window.synchronize-panes
        toggle synchronize-panes (input to every pane)

  daemon [id]       start a session daemon
  status [id]       print a session's status as JSON
  stop [id]         stop a session

  amux [session-id]   attach to a session (autostart daemon);
                        defaults to 'default'
`;
