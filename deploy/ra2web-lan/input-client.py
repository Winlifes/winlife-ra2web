"""Use the classic mouse/keyboard HUD on every device; remove virtual control options."""

JOYSTICK_OPTION = 'we.createElement("div",{className:"item","data-r-tooltip":"开启或关闭摇杆"},we.createElement("label",null,we.createElement("span",{className:"label"},"摇杆"),we.createElement("input",{type:"checkbox",defaultChecked:Eke(r),onChange:n=>{var a=!!n.target.checked;r?.setItem?.(U0,a?"1":"0"),a&&window.__ra2webVirtualJoystickLiteMountActiveGame?.(),window.__ra2webVirtualJoystickLite?.setEnabled?.(a,!1)}})))'
SHORTCUT_OPTION = 'we.createElement("div",{className:"item","data-r-tooltip":"切换移动端快捷栏位置"},we.createElement("label",null,we.createElement("span",{className:"label"},"快捷栏"),we.createElement($c.Select,{initialValue:_ke(r),onSelect:n=>r?.setItem?.(um,Xm(n))},we.createElement(Vs.Option,{value:"bottom",label:"底部"}),we.createElement(Vs.Option,{value:"side",label:"左侧"}))))'


def patch_client(text):
    changes = [
        ('function Doe(s){return t2()&&s.width>0&&s.height>0}',
         'function Doe(s){return!1/* winlife-classic-hud */}'),
        ('function RY(s){return ei(s.game?.gameOpts?.gameMode)?!1:qNe()||s.localPrefs?.getItem?.(U0)==="1"}',
         'function RY(s){return!1/* winlife-no-virtual-controls */}'),
        (JOYSTICK_OPTION, 'null/* winlife-removed-joystick-option */'),
        (SHORTCUT_OPTION, 'null/* winlife-removed-mobile-shortcuts-option */'),
    ]
    for before, after in changes:
        if after not in text:
            assert text.count(before) == 1, 'Touch control source changed: ' + before[:80]
            text = text.replace(before, after, 1)
        assert text.count(after) == 1
    return text
