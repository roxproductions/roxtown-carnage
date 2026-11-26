"""The cast and lines for the Southern voices (shared by tools/make_southern_voices.py)."""
# Every description leads with the accent (VoiceDesign drifts back to plain American otherwise) and the lines are
# spelled the way they're said. HOT people yell; EASY people stay laid-back and drawl even when it all goes wrong.
ACCENT = 'Speaks with a very thick, unmistakable American Deep South accent: slow, drawn-out vowels, a heavy twangy drawl. '
HOT = ' Angry and loud, really emotional, but natural.'
EASY = ' Relaxed and laid-back, slow and lazy, unbothered and a little amused, even when things go wrong.'
ANNOUNCER = (ACCENT + 'A booming Texas rodeo and monster-truck announcer with a deep, gravelly voice, excited and big, '
             'stretching the words out like a showman.')
COP = ACCENT + 'A heavy-set Georgia county sheriff, slow and menacing, barking orders.' + HOT

A = {
    'hurt': ["Ow! Dadgummit!", "Sweet mother of pearl, mah arm!", "Ow! Ya no-good varmint!"],
    'die': ["Lawd have mercy, Ah'm a goner!", "Tell Mama Ah love 'er!", "Not like this! Not in mah good boots!"],
    'jacked': ["Hey! That's mah truck, ya sorry sack o' possum guts!", "Git back here with mah truck, ya thievin' snake!"],
    'jack': ["Git outta the truck, now!", "Move it, slowpoke!"],
    'taunt': ["Yeehaw! Eat mah dust!", "Well, bless yer heart."],
    'panic': ["Run, y'all! Run!", "Lawd Jesus, help me!", "Somebody call the sheriff!"],
}
B = {
    'hurt': ["Aw, hell's bells!", "Ow! That smarts!", "Ya dang fool!"],
    'die': ["Ah see the light, Granny!", "Aw, shoot. Ah'm done fer.", "Nooo! Mah tractor!"],
    'jacked': ["Thief! That's mah daddy's car!", "Y'all done stole mah ride! Ah'm gonna whoop ya!"],
    'jack': ["Scoot over, Ah'm drivin'.", "Out! 'Fore Ah tan yer hide!"],
    'taunt': ["Hoo-wee, ya shoot like mah grandma!", "That all ya got, city boy?"],
    'panic': ["Git the shotgun!", "Holy moly, he's plumb crazy!", "Mama! Mama!"],
}
C = {
    'hurt': ["Ow! Son of a biscuit!", "Good gravy, that hurts!", "Ow! Ya ornery cuss!"],
    'die': ["Well, butter mah butt, Ah'm dead.", "Somebody feed mah hounds.", "Aw, heck no!"],
    'jacked': ["That's mah Cadillac, ya low-down weasel!", "Ya git back here with mah car! Ah'm fixin' to whoop ya!"],
    'jack': ["Out the car, sugar.", "Hop out, hoss. This one's mine."],
    'taunt': ["Ya got the brains of a fence post.", "Ha! Go cry to yer mama!"],
    'panic': ["Run fer the hills!", "Jumpin' Jehoshaphat!", "He's gone plumb crazy!"],
}
PEOPLE = [
    ('texas', ACCENT + 'A big Texas rancher in his fifties with a deep voice.' + HOT, A),
    ('georgia', ACCENT + 'A Georgia Southern belle in her thirties with a sweet, syrupy voice.' + EASY, B),
    ('alabama', ACCENT + 'A wiry Alabama good ol\' boy in his twenties with a twangy redneck voice.' + HOT, C),
    ('granny', ACCENT + 'An old Tennessee granny in her eighties with a creaky Appalachian voice.' + EASY, A),
    ('cajun', ACCENT + 'A Louisiana Cajun swamp man in his forties.' + EASY, B),
    ('kentucky', ACCENT + 'A Kentucky moonshiner woman in her forties with a rough country voice.' + HOT, C),
    ('preacher', ACCENT + 'A Mississippi preacher with a rich, deep, booming voice.' + HOT, B),
    ('trucker', ACCENT + 'An Arkansas trucker woman in her fifties with a smoky, raspy voice.' + EASY, A),
    ('carolina', ACCENT + 'A young South Carolina man with a high, nasal voice.' + HOT, C),
    ('florida', ACCENT + 'A Florida backwoods fisherman in his sixties with a slow, gravelly voice.' + EASY, A),
]
ANNOUNCE = {
    'wasted': 'Wasted!', 'carjacking': 'Car jackin\'!', 'frag': 'Frag!', 'roadkill': 'Road kill!',
    'win': 'Winner winner, chicken dinner!', 'newmatch': 'New match! Saddle up, y\'all!', 'busted': 'Busted, boy!',
    '0': 'Pistol!', '1': 'Dual pistols!', '2': 'Machine gun!', '3': 'Shotgun!', '4': 'Electro gun!',
    '5': 'Flame thrower!', '6': 'Rocket launcher!', '7': 'Grenades!', '8': 'Molotov cocktails!',
    '20': 'Health!', '21': 'Armor!', '22': 'Double damage!', '23': 'Invisibility!',
    '30': 'Vehicle machine gun!', '31': 'Oil slick!', '32': 'Car mines!', '33': 'Car jump!',
    'round1': 'Round one!', 'round2': 'Round two!', 'round3': 'Final round!', 'roundx': 'Next round!',
    'fight': 'Fight!', 'finish': 'Finish him!', 'fatality': 'Fatality!', 'flawless': 'Flawless victory!',
    'victory': 'Victory!', 'brutal': 'Brutal!', 'excellent': 'Hot diggity dog!', 'carcrush': 'Car crush!',
    'skyhigh': 'Sky high!', 'firestarter': 'Fire starter!', 'combo': 'Combo!',
    'race': 'Race on! Two laps, no rules!', 'three': 'Three!', 'two': 'Two!', 'one': 'One!', 'go': 'Go! Go! Go!',
    'lastlap': 'Final lap! Floor it!', 'champ': 'Race winner! Pop the bubbly, y\'all!',
}
COP_LINES = {
    'spot': ['Freeze, boy! Right there!', 'There he is, that no-good punk!', 'Stop right there, son!'],
    'arrest': ['Yer under arrest, boy!', 'Hands where Ah can see \'em!'],
    'lost': ['Where in tarnation did he go?', 'Lost the li\'l weasel.'],
    'hurt': ['Officer down!', 'Ow, mah leg!'],
}

