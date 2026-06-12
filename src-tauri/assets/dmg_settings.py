"""
dmgbuild settings for FlowWake Studio.
Called from CI: dmgbuild -s dmg_settings.py -D app=<path> -D bg=<path> "FlowWake Studio" out.dmg
"""
import os

application = defines['app']
background  = defines['bg']

files    = [application]
symlinks = {'Applications': '/Applications'}

show_status_bar = False
show_tab_view   = False
show_toolbar    = False
show_pathbar    = False
show_sidebar    = False

icon_size = 80
text_size = 12

# Finder window: position on screen then size
window_rect = ((200, 120), (660, 400))

icon_locations = {
    os.path.basename(application): (170, 160),
    'Applications':                 (490, 160),
}
