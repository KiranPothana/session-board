# Writes the card fixture's home folder (tests/cards/home): the registry, the mod's records,
# Claude Desktop's session files and a cloud row its sidebar shows, one session for each case.
# Run it after changing a case, then tests/cards/run.sh --update and read the diff.
import json, os, shutil

NOW = 1792330000000  # the time the cards are drawn at (run.sh passes the same)
MIN = 60000
here = os.path.dirname(os.path.abspath(__file__))
home = os.path.join(here, 'home')
shutil.rmtree(home, ignore_errors=True)

def write(path, data):
    path = os.path.join(home, path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w') as f:
        json.dump(data, f, indent=1, sort_keys=True)

store = {}
def session(pid, sid, name, status, rec, **reg):
    write(f'.claude/sessions/{pid}.json', {'pid': pid, 'sessionId': sid, 'cwd': '/work/' + sid, 'name': name, 'nameSource': 'user',
                                           'status': status, 'updatedAt': NOW - 5 * MIN, 'statusUpdatedAt': NOW - 5 * MIN, **reg})
    store['s:' + sid] = {'id': sid, 'cwd': '/work/' + sid, 'updatedAt': NOW - MIN, 'statusSince': NOW - 5 * MIN, 'turnEnded': status != 'busy', **rec}

def summary(task='', done='', active=(), pending=()):
    return {'task': task, 'done': done, 'active': list(active), 'pending': list(pending), 'at': NOW - 2 * MIN}

# A finished turn that asks you something (2026-10-18: the card kept bullets from an hour before)
session(101, 'question', 'Email notices', 'idle', {'status': 'idle', 'request': 'the screens look good, build the notices',
        'summary': summary('Build the notice emails', 'All suites pass', pending=['Say whether to release to the sandbox · waits on you'])},
        bridgeSessionId='session_question')
# A finished turn with nothing pending
session(102, 'finished', 'Missing tab', 'idle', {'status': 'idle', 'summary': summary('Add the missing tab', 'Shipped the tab on desktop and mobile')})
# A turn that ended with its own background runs still going (2026-10-18: called done)
session(103, 'running', 'Team runs', 'shell', {'status': 'idle', 'commandsRunning': 1,
        'summary': summary('Fix the team tab', 'Started both test runs', pending=['Commit once both runs pass'])})
# A background run that never reported back: the mod stops counting it once the session is idle
session(104, 'lost-run', 'Lost run', 'idle', {'status': 'idle', 'commandsRunning': 0, 'summary': summary('Check the exports', 'Ran the export check')})
# A permission prompt
session(105, 'prompt', 'Migration', 'waiting', {'status': 'needs-you', 'ask': 'Bash: Run the database migration',
        'summary': summary('Add the payee table', active=['Running the migration'])})
# Long text: the board keeps it whole (the card cuts it to two lines and its tooltip shows it all)
long = ('Decide whether the weekly digest goes to every team member or only to the owners, and whether it should include the '
        'payees added that week, the failed sends and the pending approvals, before the next release goes out')
session(106, 'long', 'Weekly digest', 'idle', {'status': 'idle', 'summary': summary('Plan the weekly digest email', pending=[long + ' · waits on you'])})
# A side session started from another one in Claude Desktop, and that one
session(107, 'side', 'Fix the parent bug', 'busy', {'status': 'working', 'summary': summary('Fix the missing parent', active=['Reading the session files'])},
        entrypoint='claude-desktop')
session(108, 'parent', 'Session board cloud detection', 'idle', {'status': 'idle', 'summary': summary('Show cloud sessions', 'Opened the pull request')},
        entrypoint='claude-desktop')
# A Desktop session renamed after it was resumed: the board shows Desktop's title, and Desktop's
# sidebar row under its old title is no cloud session
session(109, 'renamed', 'Old hook name', 'idle', {'status': 'idle', 'summary': summary('Design the referral screens', 'Drew the screens')},
        entrypoint='claude-desktop', nameSource='hook')
write('.claude/plugins/store/session-board_fixture.json', store)

desk = 'Library/Application Support/Claude/claude-code-sessions/account/org'
write(f'{desk}/local_side.json', {'sessionId': 'local_side', 'cliSessionId': 'side', 'title': 'Fix the parent bug',
                                  'spawnedFrom': {'sessionId': 'local_parent'}})
write(f'{desk}/local_parent.json', {'sessionId': 'local_parent', 'cliSessionId': 'parent', 'title': 'Session board cloud detection'})
write(f'{desk}/local_renamed.json', {'sessionId': 'local_renamed', 'cliSessionId': 'renamed', 'title': 'Desk team controls',
                                     'previousTitles': ['Desk referral design']})

# A cloud session in Desktop's sidebar, with the summary the mod wrote of its chat; and the
# renamed local session's old title, which the sidebar also lists under Cloud
app = 'Library/Application Support/session-board'
write(f'{app}/sidebar.json', [
    {'name': 'Referral System', 'group': 'Cloud', 'badge': '', 'state': '', 'since': NOW - 30 * MIN},
    {'name': 'Desk referral design', 'group': 'Cloud', 'badge': '', 'state': '', 'since': NOW - 30 * MIN},
])
write(f'{app}/cloud/session_referral.summary.json', {'rowId': 'cloud:referral system', 'mark': 'm1', 'at': NOW - 3 * MIN,
      'summary': summary('Add the referral screens', 'Money review passed', pending=['Approve the sandbox deploy · waits on you'])})
