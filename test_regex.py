import re
t = "Home Care Patient Details"
inputs = [
    "'Home Care Patient Details'[SERVICE TYPE]",
    "\"Home Care Patient Details\".\"SERVICE TYPE\"",
    "Home Care Patient Details.SERVICE TYPE"
]
for txt in inputs:
    print(txt, "->", bool(re.search(r"(?i)\b"+re.escape(t)+r"['\"]?\s*([\[\.])", txt)))
