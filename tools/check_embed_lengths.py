import json
from pathlib import Path
files=[Path(r'd:\Codding\Khersonec\data\embeds\kherson_rules.json'), Path(r'd:\Codding\Khersonec\data\embeds\rules.json'), Path(r'd:\Codding\Khersonec\data\embeds\info.json'), Path(r'd:\Codding\Khersonec\data\embeds\codes.json'), Path(r'd:\Codding\Khersonec\data\embeds\about_en.json'), Path(r'd:\Codding\Khersonec\data\embeds\about_uk.json')]
for f in files:
    s=f.read_text(encoding='utf-8')
    try:
        j=json.loads(s)
    except Exception as e:
        print(f.name, 'JSON_ERROR', e)
        continue
    emb=j.get('embed',{})
    title=emb.get('title','')
    desc=emb.get('description','')
    footer=emb.get('footer',{}).get('text','')
    print(f"{f.name}: title={len(title)} chars, desc={len(desc)} chars, footer={len(footer)} chars")
    if len(title)>256:
        print('  -> TITLE too long')
    if len(desc)>4096:
        print('  -> DESCRIPTION too long')
    if len(footer)>2048:
        print('  -> FOOTER too long')
