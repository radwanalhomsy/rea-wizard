/**
 * Deep GUI reader and GUI clone generator.
 *
 * The plain UI map captures only the window that is visible at that instant.
 * This module expands the real accessibility tree: every top-level window,
 * menu bar, submenu, tab surface and tree node is opened with UI Automation,
 * captured as a durable evidence file, and turned into a deterministic,
 * browser-renderable GUI clone.
 *
 * Honesty rules:
 *  - only controls actually exposed by UI Automation become nodes
 *  - every node cites the capture evidence ID
 *  - generated HTML is a structural/interaction clone, not a binary replacement
 *  - verification counts real nodes in the generated data file; it never
 *    claims coverage for a node that was not written
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { getProject, projectPaths, addEvidence, recordCase } from './cloneStore.mjs'

const GUI_SCRIPT = `
param([int]$ProcId = 0, [string]$Title = '', [string]$Output = '', [int]$Max = 4000, [int]$Depth = 12, [int]$MaxMenus = 60, [int]$MaxTabs = 30, [int]$MaxTrees = 60, [int]$DelayMs = 120)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class GuiInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  public static void Focus(IntPtr hWnd) {
    SetForegroundWindow(hWnd);
  }
  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
  }
  public static void RightClick(int x, int y) {
    SetCursorPos(x, y);
    mouse_event(0x0008, 0, 0, 0, UIntPtr.Zero);
    mouse_event(0x0010, 0, 0, 0, UIntPtr.Zero);
  }
  public static void Escape() {
    keybd_event(0x1B, 0, 0, UIntPtr.Zero);
    keybd_event(0x1B, 0, 0x0002, UIntPtr.Zero);
  }
}
"@
[GuiInput]::Escape()
Start-Sleep -Milliseconds 60
$root = [System.Windows.Automation.AutomationElement]::RootElement
$failures = @()
$windows = New-Object 'System.Collections.Generic.List[object]'
if ($ProcId -gt 0) {
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ProcId)
  $found = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
  foreach ($w in $found) {
    try {
      $r = $w.Current.BoundingRectangle
      if (($r.Width * $r.Height) -gt 100) { $windows.Add($w) }
    } catch { }
  }
}
if ($windows.Count -eq 0 -and $Title) {
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($w in $all) {
    try {
      if ($w.Current.Name -like ('*' + $Title + '*')) {
        $r = $w.Current.BoundingRectangle
        if (($r.Width * $r.Height) -gt 100) { $windows.Add($w) }
      }
    } catch { }
  }
}
if ($windows.Count -eq 0) { throw 'No matching window was found' }
$primary = $windows[0]
foreach ($w in $windows) {
  try {
    $r = $w.Current.BoundingRectangle
    $rp = $primary.Current.BoundingRectangle
    if (($r.Width * $r.Height) -gt ($rp.Width * $rp.Height)) { $primary = $w }
  } catch { }
}
$primaryHandle = [int]$primary.Current.NativeWindowHandle
[GuiInput]::Focus([IntPtr]$primaryHandle)
Start-Sleep -Milliseconds 80
$nodes = New-Object 'System.Collections.Generic.List[object]'
$seen = New-Object 'System.Collections.Generic.HashSet[string]'
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$rawWalker = [System.Windows.Automation.TreeWalker]::RawViewWalker
function Get-Children($element, $useRaw) {
  $list = New-Object 'System.Collections.Generic.List[object]'
  $w = $walker
  if ($useRaw) { $w = $rawWalker }
  try {
    $child = $w.GetFirstChild($element)
    $guard = 0
    while ($child -and $guard -lt 5000) {
      $guard++
      $list.Add($child)
      $child = $w.GetNextSibling($child)
    }
  } catch { }
  return $list
}
function Add-Nodes($element, $surface, $parentPath, $depthLeft, $useRaw) {
  if ($null -eq $element -or $nodes.Count -ge $Max -or $depthLeft -lt 0) { return }
  $stack = New-Object 'System.Collections.Generic.Stack[object]'
  $stack.Push(@{ e = $element; p = $parentPath; d = 0 })
  while ($stack.Count -gt 0 -and $nodes.Count -lt $Max) {
    $item = $stack.Pop()
    $e = $item.e
    try {
      $c = $e.Current
      $r = $c.BoundingRectangle
      $name = [string]$c.Name
      $type = [string]$c.ControlType.ProgrammaticName
      $type = $type.Replace('ControlType.', '')
      $nodePath = ($item.p + '/' + $type + ':' + $name).TrimStart('/')
      $key = '{0}|{1}|{2}|{3}|{4}|{5}|{6}|{7}|{8}|{9}' -f @($surface, $nodePath, $name, $type, [string]$c.AutomationId, [string]$c.ClassName, [int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height)
      if ($seen.Add($key)) {
        $patterns = @()
        try { $patterns = @($e.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName }) } catch { }
        $node = [pscustomobject]@{
          surface = [string]$surface
          path = [string]$nodePath
          parentPath = [string]$item.p
          name = $name
          label = $name
          type = $type
          automationId = [string]$c.AutomationId
          className = [string]$c.ClassName
          enabled = [bool]$c.IsEnabled
          offscreen = [bool]$c.IsOffscreen
          x = [int]$r.X
          y = [int]$r.Y
          width = [int]$r.Width
          height = [int]$r.Height
          patterns = ($patterns -join ',')
          depth = [int]$item.d
        }
        $nodes.Add($node)
        if ($item.d -lt $depthLeft) {
          foreach ($child in (Get-Children $e $useRaw)) {
            $stack.Push(@{ e = $child; p = $nodePath; d = ($item.d + 1) })
          }
        }
      }
    } catch {
      $failures += ('walk: ' + $_.Exception.Message)
    }
  }
}
function Find-ByType($element, $typeName, $limit) {
  $out = New-Object 'System.Collections.Generic.List[object]'
  if ($null -eq $element) { return $out }
  $stack = New-Object 'System.Collections.Generic.Stack[object]'
  $stack.Push($element)
  $visited = New-Object 'System.Collections.Generic.HashSet[string]'
  while ($stack.Count -gt 0 -and $out.Count -lt $limit) {
    $e = $stack.Pop()
    try {
      if (-not $visited.Add([string]$e.GetHashCode())) { continue }
      $c = $e.Current
      if ($c.ControlType.ProgrammaticName -eq ('ControlType.' + $typeName)) { $out.Add($e) }
      foreach ($child in (Get-Children $e $true)) { $stack.Push($child) }
    } catch { }
  }
  return $out
}
function Get-WindowHandles {
  $handles = @()
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($w in $all) {
    try {
      if ($w.Current.ProcessId -eq $primary.Current.ProcessId) {
        $r = $w.Current.BoundingRectangle
        if (($r.Width * $r.Height) -gt 100) { $handles += [int]$w.Current.NativeWindowHandle }
      }
    } catch { }
  }
  return $handles
}
$modalName1 = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, 'Settings')
$modalName2 = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, 'Options')
$modalName3 = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, 'Preferences')
$modalNameOr1 = New-Object System.Windows.Automation.OrCondition($modalName1, $modalName2)
$modalNameCondition = New-Object System.Windows.Automation.OrCondition($modalNameOr1, $modalName3)
function Close-ModalDialogs {
  if ($null -eq $primary) { return }
  $found = $primary.FindAll([System.Windows.Automation.TreeScope]::Descendants, $modalNameCondition)
  foreach ($e in $found) {
    try {
      if ($e.Current.ControlType.ProgrammaticName -ne 'ControlType.Window') { continue }
      $pat = $null
      if ($e.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern, [ref]$pat)) {
        $pat.Close()
        Start-Sleep -Milliseconds $DelayMs
      }
    } catch { }
  }
}
$steps = New-Object 'System.Collections.Generic.List[object]'
$collapsibles = New-Object 'System.Collections.Generic.List[object]'
foreach ($w in $windows) {
  $windowTitle = [string]$w.Current.Name
  Add-Nodes $w ('window:' + $windowTitle) '' ([Math]::Min($Depth, 12)) $false
}
$menuCandidates = New-Object 'System.Collections.Generic.List[object]'
$menuCandidateKeys = New-Object 'System.Collections.Generic.HashSet[string]'
$appTitle = ([string]$primary.Current.Name).Trim()
$menuItemCondition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::MenuItem)
foreach ($typeName in @('MenuItem', 'MenuBar', 'Menu', 'Button')) {
  foreach ($item in (Find-ByType $primary $typeName ([Math]::Min(2000, ($Max * 2))))) {
    if ($menuCandidates.Count -ge $MaxMenus) { break }
    try {
      $c = $item.Current
      if (-not $c.IsEnabled -or $c.IsOffscreen) { continue }
      $name = [string]$c.Name
      if ([string]::IsNullOrWhiteSpace($name)) { continue }
      $type = [string]$c.ControlType.ProgrammaticName
      $isMenu = ($type -in @('ControlType.MenuItem', 'ControlType.MenuBar', 'ControlType.Menu'))
      $isAppButton = ($type -eq 'ControlType.Button' -and
        (($name.Trim() -eq $appTitle) -or ($name -match '(?i)menu|more')))
      if (-not $isMenu -and -not $isAppButton) { continue }
      $blocked = $name -match '(?i)close|clear|delete|remove|save|undo|redo|copy|move|add|open|exit|apply|ok|cancel|start|stop|language|setting|option|preference|config'
      if ($blocked) { continue }
      $key = $type + '|' + $name
      if ($menuCandidateKeys.Add($key)) { $menuCandidates.Add($item) }
    } catch { }
  }
}
$tabItems = Find-ByType $primary 'TabItem' $MaxTabs
$selectedTab = $null
foreach ($tab in $tabItems) {
  if ($nodes.Count -ge $Max) { break }
  try {
    $c = $tab.Current
    if (-not $c.IsEnabled -or $c.IsOffscreen -or [string]::IsNullOrWhiteSpace($c.Name)) { continue }
    $sel = $null
    if ($tab.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$sel)) {
      if ($sel.Current.IsSelected) { $selectedTab = $sel }
      $sel.Select()
    } else {
      $invoke = $null
      if ($tab.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) { $invoke.Invoke() }
    }
    Start-Sleep -Milliseconds $DelayMs
    $steps.Add([pscustomobject]@{ action = 'select-tab'; target = $c.Name; status = 'ok' })
    Add-Nodes $primary ('tab:' + $c.Name) ('tab/' + $c.Name) $Depth $false
  } catch {
    $failures += ('tab: ' + $_.Exception.Message)
  }
}
foreach ($item in $menuCandidates) {
  if ($nodes.Count -ge $Max) { break }
  try {
    $c = $item.Current
    $name = [string]$c.Name
    $surface = 'menu:' + $name
    $beforeHandles = @(Get-WindowHandles)
    $r = $c.BoundingRectangle
    if ($r.Width -le 0 -or $r.Height -le 0) { continue }
    [GuiInput]::Focus([IntPtr]$primaryHandle)
    [GuiInput]::Click([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2))
    Start-Sleep -Milliseconds $DelayMs
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    $popups = @()
    foreach ($w in $all) {
      try {
        if ($w.Current.ProcessId -ne $primary.Current.ProcessId) { continue }
        $h = [int]$w.Current.NativeWindowHandle
        if ($beforeHandles -contains $h) { continue }
        $wr = $w.Current.BoundingRectangle
        if (($wr.Width * $wr.Height) -lt 100) { continue }
        if ($w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $menuItemCondition).Count -gt 0) {
          $popups += $w
        }
      } catch { }
    }
    foreach ($w in $popups) {
      Add-Nodes $w $surface ('menu/' + $name) ([Math]::Min($Depth, 8)) $true
      $steps.Add([pscustomobject]@{ action = 'open-menu'; target = $name; status = 'ok' })
      $subItems = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $menuItemCondition)
      foreach ($mi in $subItems) {
        try {
          $mc = $mi.Current
          if ([string]::IsNullOrWhiteSpace($mc.Name)) { continue }
          $ec = $null
          if (-not $mi.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$ec)) { continue }
          if ($ec.Current.ExpandCollapseState -eq [System.Windows.Automation.ExpandCollapseState]::Expanded) { continue }
          $ec.Expand()
          Start-Sleep -Milliseconds $DelayMs
          $collapsibles.Add(@{ p = $ec; n = $mc.Name })
          $steps.Add([pscustomobject]@{ action = 'expand-submenu'; target = $mc.Name; status = 'ok' })
          Add-Nodes $mi ($surface + '/' + $mc.Name) ('menu/' + $name + '/' + $mc.Name) ([Math]::Min($Depth, 6)) $true
        } catch { }
      }
    }
    [GuiInput]::Escape()
    Start-Sleep -Milliseconds ([Math]::Max(30, [int]($DelayMs / 2)))
  } catch {
    $failures += ('menu: ' + $_.Exception.Message)
    try { [GuiInput]::Escape() } catch { }
  }
}
# right-click context menus (these carry most submenus in Qt apps)
$contextTargets = @()
foreach ($typeName in @('Header', 'Table', 'Tree')) {
  foreach ($t in (Find-ByType $primary $typeName 8)) {
    try {
      $tr = $t.Current.BoundingRectangle
      if ($tr.Width -gt 100 -and $tr.Height -gt 40 -and $t.Current.IsEnabled) { $contextTargets += $t }
    } catch { }
  }
}
foreach ($t in ($contextTargets | Select-Object -First 3)) {
  if ($nodes.Count -ge $Max) { break }
  try {
    $tc = $t.Current
    $tr = $tc.BoundingRectangle
    [GuiInput]::Focus([IntPtr]$primaryHandle)
    [GuiInput]::RightClick([int]($tr.X + $tr.Width / 2), [int]($tr.Y + $tr.Height / 2))
    Start-Sleep -Milliseconds $DelayMs
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($w in $all) {
      try {
        if ($w.Current.ProcessId -ne $primary.Current.ProcessId) { continue }
        $h = [int]$w.Current.NativeWindowHandle
        if ($h -eq $primaryHandle) { continue }
        if ($w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $menuItemCondition).Count -eq 0) { continue }
        $cSurface = 'context:' + ($tc.Name -replace '[^A-Za-z0-9 ]', '_').Trim()
        if ([string]::IsNullOrWhiteSpace($cSurface)) { $cSurface = 'context:' + $tc.ControlType.ProgrammaticName }
        Add-Nodes $w $cSurface ('context/' + $tc.ControlType.ProgrammaticName) ([Math]::Min($Depth, 8)) $true
        $steps.Add([pscustomobject]@{ action = 'open-context-menu'; target = $tc.ControlType.ProgrammaticName; status = 'ok' })
        $subItems = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $menuItemCondition)
        foreach ($mi in $subItems) {
          try {
            $mc = $mi.Current
            if ([string]::IsNullOrWhiteSpace($mc.Name)) { continue }
            $ec = $null
            if (-not $mi.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$ec)) { continue }
            if ($ec.Current.ExpandCollapseState -eq [System.Windows.Automation.ExpandCollapseState]::Expanded) { continue }
            $ec.Expand()
            Start-Sleep -Milliseconds $DelayMs
            $collapsibles.Add(@{ p = $ec; n = $mc.Name })
            $steps.Add([pscustomobject]@{ action = 'expand-submenu'; target = $mc.Name; status = 'ok' })
            Add-Nodes $mi ($cSurface + '/' + $mc.Name) ('context/' + $mc.Name) ([Math]::Min($Depth, 6)) $true
          } catch { }
        }
        [GuiInput]::Escape()
        Start-Sleep -Milliseconds ([Math]::Max(30, [int]($DelayMs / 2)))
      } catch { }
    }
    [GuiInput]::Escape()
  } catch {
    $failures += ('context-menu: ' + $_.Exception.Message)
    try { [GuiInput]::Escape() } catch { }
  }
}
if ($null -ne $selectedTab) { try { $selectedTab.Select() } catch { } }
$treeItems = Find-ByType $primary 'TreeItem' $MaxTrees
foreach ($item in $treeItems) {
  if ($nodes.Count -ge $Max) { break }
  try {
    $c = $item.Current
    if (-not $c.IsEnabled -or [string]::IsNullOrWhiteSpace($c.Name)) { continue }
    $pat = $null
    if ($item.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pat)) {
      if ($pat.Current.ExpandCollapseState -ne [System.Windows.Automation.ExpandCollapseState]::Expanded) {
        $pat.Expand()
        $collapsibles.Add(@{ p = $pat; n = $c.Name })
        Start-Sleep -Milliseconds $DelayMs
        $steps.Add([pscustomobject]@{ action = 'expand-tree'; target = $c.Name; status = 'ok' })
        Add-Nodes $item ('tree:' + $c.Name) ('tree/' + $c.Name) ([Math]::Min($Depth, 8)) $true
      }
    }
  } catch {
    $failures += ('tree: ' + $_.Exception.Message)
  }
}
for ($i = $collapsibles.Count - 1; $i -ge 0; $i--) {
  try { $collapsibles[$i].p.Collapse() } catch { }
}
$surfaceList = @($nodes | ForEach-Object { $_.surface } | Sort-Object -Unique)
$result = [pscustomobject]@{
  title = [string]$primary.Current.Name
  processId = [int]$primary.Current.ProcessId
  windows = @($windows | ForEach-Object { [string]$_.Current.Name })
  nodes = @($nodes.ToArray())
  surfaces = $surfaceList
  steps = @($steps.ToArray())
  failures = @($failures | Select-Object -First 50)
}
$result | ConvertTo-Json -Depth 10 -Compress | Set-Content -Path $Output -Encoding UTF8
`

function hash(value, length = 12) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length)
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function relTo(base, file) {
  return path.relative(base, file).split(path.sep).join('/')
}

function clamp(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.floor(n)))
}

function normalizeNode(node, index) {
  const bounds = node.bounds || {}
  const x = Number(node.x) || 0
  const y = Number(node.y) || 0
  const width = Number(node.width ?? bounds.width) || 0
  const height = Number(node.height ?? bounds.height) || 0
  const name = String(node.name || node.label || node.automationId || node.className || 'control')
  const surface = String(node.surface || 'root')
  const nodePath = String(node.path || '')
  const type = String(node.type || '').replace('ControlType.', '') || 'unknown'
  const identity = [
    surface, nodePath, name, type,
    String(node.automationId || ''), String(node.className || ''),
    x, y, width, height,
  ].join('|')
  return {
    id: `gn_${hash(identity, 12)}`,
    index,
    surface,
    path: nodePath,
    parentPath: String(node.parentPath || ''),
    name,
    label: String(node.label || name),
    type,
    automationId: String(node.automationId || ''),
    className: String(node.className || ''),
    enabled: Boolean(node.enabled),
    offscreen: Boolean(node.offscreen),
    bounds: { x, y, width, height },
    patterns: Array.isArray(node.patterns)
      ? node.patterns
      : String(node.patterns || '').split(',').map((p) => p.trim()).filter(Boolean),
    depth: Number(node.depth) || 0,
  }
}

function summarize(nodes, surfaces) {
  const menuSurfaces = surfaces.filter((s) => s.startsWith('menu:') || s.startsWith('context:'))
  const tabSurfaces = surfaces.filter((s) => s.startsWith('tab:'))
  const treeSurfaces = surfaces.filter((s) => s.startsWith('tree:'))
  return {
    nodes: nodes.length,
    surfaces: surfaces.length,
    windows: surfaces.filter((s) => s.startsWith('window:')).length,
    menuSurfaces: menuSurfaces.length,
    tabSurfaces: tabSurfaces.length,
    treeSurfaces: treeSurfaces.length,
    menuItems: nodes.filter((n) => n.type === 'MenuItem').length,
    submenus: nodes.filter((n) => n.parentPath.includes('/MenuItem:') || n.surface.includes('/')).length,
    tabs: nodes.filter((n) => n.type === 'TabItem').length,
    treeItems: nodes.filter((n) => n.type === 'TreeItem').length,
  }
}

/** Open every window/menu/submenu/tab/tree node of a live target via UIA. */
export async function captureGuiTree(workspace, slug, options = {}) {
  if (process.platform !== 'win32') throw new Error('Deep GUI reading is available on Windows only')
  const {
    pid = null,
    windowTitle = '',
    target = null,
    seconds = 5,
    closeAfter = false,
    max = 4000,
    depth = 12,
    maxMenus = 60,
    maxTabs = 30,
    maxTrees = 60,
    delayMs = 120,
  } = options

  let child = null
  let usePid = Number(pid) || 0
  let useTitle = String(windowTitle || '')
  if (!usePid && !useTitle && target) {
    if (typeof target !== 'string' || !fs.existsSync(target)) throw new Error('Target executable does not exist')
    child = spawn(target, [], { cwd: path.dirname(target), detached: true, stdio: 'ignore', windowsHide: false })
    usePid = child.pid || 0
    await new Promise((resolve) => setTimeout(resolve, clamp(seconds, 1, 30, 5) * 1000))
  }

  const paths = projectPaths(workspace, slug)
  const script = path.join(os.tmpdir(), `rea-gui-${process.pid}-${Date.now()}.ps1`)
  const output = path.join(os.tmpdir(), `rea-gui-${process.pid}-${Date.now()}.json`)
  fs.writeFileSync(script, GUI_SCRIPT, 'utf8')
  try {
    // Async spawn is required: blocking Electron's main thread can deadlock UIA.
    const res = await new Promise((resolve, reject) => {
      const ps = spawn('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
        '-ProcId', String(usePid), '-Title', useTitle, '-Output', output,
        '-Max', String(clamp(max, 100, 12000, 4000)),
        '-Depth', String(clamp(depth, 1, 20, 12)),
        '-MaxMenus', String(clamp(maxMenus, 0, 200, 60)),
        '-MaxTabs', String(clamp(maxTabs, 0, 200, 30)),
        '-MaxTrees', String(clamp(maxTrees, 0, 200, 60)),
        '-DelayMs', String(clamp(delayMs, 0, 1000, 120)),
      ], { windowsHide: true })
      let stdout = ''
      let stderr = ''
      let bytes = 0
      const limit = 8 * 1024 * 1024
      ps.stdout.setEncoding('utf8')
      ps.stderr.setEncoding('utf8')
      ps.stdout.on('data', (d) => { bytes += d.length; if (bytes <= limit) stdout += d })
      ps.stderr.on('data', (d) => { bytes += d.length; if (bytes <= limit) stderr += d })
      const timer = setTimeout(() => { ps.kill(); reject(new Error('Deep GUI capture timed out')) }, 180000)
      ps.on('error', (e) => { clearTimeout(timer); reject(e) })
      ps.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
    })
    if (res.code !== 0) throw new Error(String(res.stderr || res.stdout || 'Deep GUI capture failed').trim().slice(0, 500))
    const raw = JSON.parse(fs.readFileSync(output, 'utf8').replace(/^\uFEFF/, ''))
    const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : [raw.nodes].filter(Boolean)
    const nodes = rawNodes.map(normalizeNode)
    if (!nodes.length) throw new Error('The accessibility tree exposed no controls')
    const surfaces = Array.isArray(raw.surfaces) ? raw.surfaces.filter(Boolean) : [...new Set(nodes.map((n) => n.surface))]
    const summary = summarize(nodes, surfaces)
    const steps = (Array.isArray(raw.steps) ? raw.steps : []).map((s, i) => ({
      index: i + 1,
      action: String(s.action || 'expand'),
      target: String(s.target || ''),
      status: String(s.status || 'ok'),
    }))
    const evidence = `ev_gui_${hash(JSON.stringify({ title: raw.title, nodes, surfaces }))}`

    fs.mkdirSync(paths.evidence, { recursive: true })
    const rawFile = path.join(paths.evidence, `gui-tree-${stamp()}.json`)
    fs.writeFileSync(rawFile, JSON.stringify(raw, null, 2) + '\n', 'utf8')

    const tree = {
      schema: 1,
      at: new Date().toISOString(),
      title: String(raw.title || useTitle || ''),
      processId: Number(raw.processId) || usePid || null,
      source: child ? 'launched-target' : usePid ? 'pid' : 'window-title',
      evidence,
      rawFile: relTo(paths.dir, rawFile),
      windows: Array.isArray(raw.windows) ? raw.windows : [],
      surfaces,
      nodes,
      steps,
      summary,
      failures: Array.isArray(raw.failures) ? raw.failures : [],
    }
    fs.mkdirSync(paths.spec, { recursive: true })
    fs.writeFileSync(path.join(paths.spec, 'ui-tree.json'), JSON.stringify(tree, null, 2) + '\n', 'utf8')

    // Keep ui-map.json compatible while widening it to every discovered surface.
    const map = {
      schema: 2,
      at: tree.at,
      title: tree.title,
      processId: tree.processId,
      source: tree.source,
      evidence,
      surfaces,
      summary,
      controls: nodes.map((n) => ({
        id: n.id,
        surface: n.surface,
        path: n.path,
        parentPath: n.parentPath,
        screen: n.surface,
        name: n.name,
        label: n.label,
        type: n.type,
        automationId: n.automationId,
        className: n.className,
        enabled: n.enabled,
        offscreen: n.offscreen,
        bounds: n.bounds,
        parent: n.parentPath,
      })),
    }
    fs.writeFileSync(path.join(paths.spec, 'ui-map.json'), JSON.stringify(map, null, 2) + '\n', 'utf8')

    addEvidence(workspace, slug, {
      id: evidence,
      source: 'gui-tree',
      stage: 'behavior',
      note: `Deep GUI tree: ${nodes.length} nodes, ${surfaces.length} surfaces (${summary.menuSurfaces} menus, ${summary.tabSurfaces} tabs)`,
      file: tree.rawFile,
    })

    const recorded = recordCase(workspace, slug, {
      tool: 'capture_native_ui_scenario',
      title: `${tree.title || 'Target'} full GUI structure capture`,
      status: 'ok',
      input: {
        pid: usePid || null,
        window_title: useTitle || null,
        target: target || null,
        max,
        depth,
        expand_menus: maxMenus > 0,
        expand_tabs: maxTabs > 0,
        expand_trees: maxTrees > 0,
      },
      output: {
        window: tree.title,
        pid: tree.processId,
        ui_tree_evidence: evidence,
        surfaces,
        summary,
        steps,
      },
    })

    return {
      title: tree.title,
      processId: tree.processId,
      evidence,
      summary,
      steps: steps.length,
      case: recorded.id,
      files: ['spec/ui-tree.json', 'spec/ui-map.json', tree.rawFile],
    }
  } finally {
    try { fs.rmSync(script, { force: true }) } catch { }
    try { fs.rmSync(output, { force: true }) } catch { }
    if (child && closeAfter && child.pid) {
      try { process.kill(-child.pid) } catch {
        spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
      }
    }
  }
}

export function readGuiTree(workspace, slug) {
  const paths = projectPaths(workspace, slug)
  try {
    return JSON.parse(fs.readFileSync(path.join(paths.spec, 'ui-tree.json'), 'utf8'))
  } catch {
    return null
  }
}

export function readGuiClone(workspace, slug) {
  const paths = projectPaths(workspace, slug)
  try {
    return JSON.parse(fs.readFileSync(path.join(paths.clone, 'gui', 'manifest.json'), 'utf8'))
  } catch {
    return null
  }
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const GUI_APP = `
const tree = window.__GUI_TREE__
const nodes = tree.nodes || []
const byId = new Map(nodes.map(function (n) { return [n.id, n] }))
const root = document.getElementById('guiRoot')
const list = document.getElementById('guiControlList')
const count = document.getElementById('guiCount')
const bounds = (function () {
  const boxes = nodes.filter(function (n) { return n.bounds && n.bounds.width > 0 && n.bounds.height > 0 })
  if (!boxes.length) return { x: 0, y: 0, width: 1280, height: 800 }
  const x = Math.min.apply(null, boxes.map(function (n) { return n.bounds.x }))
  const y = Math.min.apply(null, boxes.map(function (n) { return n.bounds.y }))
  const right = Math.max.apply(null, boxes.map(function (n) { return n.bounds.x + n.bounds.width }))
  const bottom = Math.max.apply(null, boxes.map(function (n) { return n.bounds.y + n.bounds.height }))
  return { x: x, y: y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) }
})()
const surface = document.createElement('div')
surface.className = 'gui-surface'
surface.style.width = bounds.width + 'px'
surface.style.height = bounds.height + 'px'
root.appendChild(surface)
const elements = new Map()
nodes.forEach(function (n) {
  const el = document.createElement('div')
  el.className = 'gui-node gui-' + String(n.type || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  el.setAttribute('data-node-id', n.id)
  el.setAttribute('data-surface', n.surface)
  el.setAttribute('data-path', n.path)
  el.setAttribute('data-parent-path', n.parentPath)
  el.setAttribute('data-name', n.name)
  el.title = n.type + ': ' + n.name + ' [' + n.surface + ']'
  const b = n.bounds || {}
  if (b.width > 0 && b.height > 0) {
    el.style.left = (b.x - bounds.x) + 'px'
    el.style.top = (b.y - bounds.y) + 'px'
    el.style.width = b.width + 'px'
    el.style.height = b.height + 'px'
  } else {
    el.style.display = 'none'
  }
  if (n.type === 'Button' || n.type === 'MenuItem' || n.type === 'TabItem' || n.type === 'CheckBox') {
    el.textContent = n.label || n.name
    el.classList.add('gui-actionable')
  }
  surface.appendChild(el)
  elements.set(n.id, el)
  const item = document.createElement('div')
  item.className = 'gui-list-item'
  item.setAttribute('data-list-node', n.id)
  item.textContent = n.type + ' · ' + n.name + ' · ' + n.surface
  item.addEventListener('click', function () {
    document.querySelectorAll('.gui-selected').forEach(function (x) { x.classList.remove('gui-selected') })
    el.classList.add('gui-selected')
    document.getElementById('guiDetail').textContent = JSON.stringify(n, null, 2)
  })
  list.appendChild(item)
})
const tabSurfaces = Array.from(new Set(nodes.map(function (n) { return n.surface }).filter(function (s) { return s.indexOf('tab:') === 0 })))
let activeTab = tabSurfaces[0] || null
const openMenus = new Set()
const openTrees = new Set()
function groupOf(surface) {
  if (surface.indexOf('tab:') === 0) return 'tab'
  if (surface.indexOf('menu:') === 0) return 'menu'
  if (surface.indexOf('tree:') === 0) return 'tree'
  return 'base'
}
function refresh() {
  nodes.forEach(function (n) {
    const el = elements.get(n.id)
    if (!el) return
    const g = groupOf(n.surface)
    let visible = true
    if (g === 'tab') visible = activeTab === null || n.surface === activeTab
    if (g === 'menu') visible = openMenus.has(n.surface)
    if (g === 'tree') visible = openTrees.has(n.surface)
    el.style.visibility = visible ? 'visible' : 'hidden'
  })
  document.querySelectorAll('[data-surface]').forEach(function (el) {
    if (el.classList.contains('gui-tab-button')) el.classList.toggle('gui-active', el.getAttribute('data-surface') === activeTab)
  })
  count.textContent = Array.from(elements.values()).filter(function (el) { return el.style.visibility !== 'hidden' }).length + ' / ' + nodes.length + ' visible nodes'
}
nodes.filter(function (n) { return n.type === 'TabItem' && n.surface.indexOf('tab:') !== 0 }).forEach(function (n) {
  const btn = document.createElement('button')
  btn.className = 'gui-tab-button'
  btn.textContent = n.name
  btn.setAttribute('data-surface', 'tab:' + n.name)
  btn.addEventListener('click', function () { activeTab = 'tab:' + n.name; refresh() })
  document.getElementById('guiTabs').appendChild(btn)
})
nodes.filter(function (n) { return n.type === 'MenuItem' && n.surface.indexOf('menu:') !== 0 }).forEach(function (n) {
  const btn = document.createElement('button')
  btn.className = 'gui-menu-button'
  btn.textContent = n.name
  btn.setAttribute('data-surface', 'menu:' + n.name)
  btn.addEventListener('click', function () {
    const key = 'menu:' + n.name
    if (openMenus.has(key)) openMenus.delete(key); else openMenus.add(key)
    refresh()
  })
  document.getElementById('guiMenus').appendChild(btn)
})
surface.addEventListener('click', function (event) {
  const el = event.target.closest('[data-node-id]')
  if (!el) return
  const n = byId.get(el.getAttribute('data-node-id'))
  if (!n) return
  document.getElementById('guiDetail').textContent = JSON.stringify(n, null, 2)
  if (n.type === 'MenuItem' && n.surface.indexOf('menu:') === 0) {
    const key = n.surface
    if (openMenus.has(key)) openMenus.delete(key); else openMenus.add(key)
  }
  if (n.type === 'TabItem' && n.surface.indexOf('tab:') !== 0) activeTab = 'tab:' + n.name
  if (n.type === 'TreeItem') {
    const key = n.surface
    if (openTrees.has(key)) openTrees.delete(key); else openTrees.add(key)
  }
  refresh()
})
window.__GUI_RENDERED__ = nodes.length
refresh()
`

/** Generate a deterministic, browser-renderable structural clone of the GUI. */
export function generateGuiClone(workspace, slug) {
  const project = getProject(workspace, slug)
  if (!project) throw new Error(`No clone project "${slug}"`)
  const tree = readGuiTree(workspace, slug)
  if (!tree) throw new Error('No deep GUI tree captured for this project')
  const paths = projectPaths(workspace, slug)
  const dir = path.join(paths.clone, 'gui')
  fs.mkdirSync(dir, { recursive: true })

  const data = {
    schema: 1,
    title: tree.title,
    evidence: tree.evidence,
    processId: tree.processId,
    capturedAt: tree.at,
    surfaces: tree.surfaces,
    nodes: tree.nodes,
    steps: tree.steps,
  }
  fs.writeFileSync(path.join(dir, 'data.js'), `window.__GUI_TREE__ = ${JSON.stringify(data)}\n`, 'utf8')
  fs.writeFileSync(path.join(dir, 'app.js'), GUI_APP, 'utf8')
  fs.writeFileSync(path.join(dir, 'styles.css'), `
* { box-sizing: border-box; }
body { margin: 0; background: #0f1420; color: #d8e2f2; font: 12px/1.4 Segoe UI, sans-serif; }
#guiLayout { display: flex; height: 100vh; }
#guiStage { flex: 1; overflow: auto; padding: 12px; }
#guiRoot { transform-origin: top left; }
.gui-surface { position: relative; background: #e8edf5; border: 1px solid #7e8aa0; }
.gui-node { position: absolute; border: 1px solid rgba(30,50,90,0.35); background: rgba(255,255,255,0.55); color: #16233b; overflow: hidden; }
.gui-button, .gui-menuitem, .gui-tabitem, .gui-checkbox { background: #f5f7fb; }
.gui-actionable { cursor: pointer; }
.gui-node.gui-selected { outline: 2px solid #d64b4b; z-index: 5; }
#guiInspector { width: 320px; border-left: 1px solid #2b3550; padding: 10px; overflow: auto; background: #141b2b; }
#guiTabs, #guiMenus { display: flex; flex-wrap: wrap; gap: 4px; margin: 6px 0; }
#guiTabs button, #guiMenus button { background: #24304a; color: #d8e2f2; border: 1px solid #3c4a68; border-radius: 4px; padding: 3px 7px; cursor: pointer; }
#guiTabs button.gui-active { background: #3869c4; border-color: #6f9cf0; }
#guiControlList { max-height: 300px; overflow: auto; border: 1px solid #2b3550; }
.gui-list-item { padding: 3px 6px; border-bottom: 1px solid #202940; cursor: pointer; }
.gui-list-item:hover { background: #202a42; }
#guiDetail { white-space: pre-wrap; font: 11px/1.35 Consolas, monospace; color: #9fc5ff; }
#guiCount { color: #8ea4c8; margin: 6px 0; }
`, 'utf8')

  fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(tree.title || 'GUI clone')} — structural clone</title>
  <link rel="stylesheet" href="styles.css" />
</head>
<body>
  <div id="guiLayout">
    <div id="guiStage"><div id="guiRoot"></div></div>
    <aside id="guiInspector">
      <h3>${esc(tree.title || 'GUI clone')}</h3>
      <div id="guiCount">loading…</div>
      <div><b>Tabs</b><div id="guiTabs"></div></div>
      <div><b>Menus</b><div id="guiMenus"></div></div>
      <div><b>All controls</b><div id="guiControlList"></div></div>
      <pre id="guiDetail">Select a control to inspect its captured data.</pre>
    </aside>
  </div>
  <script src="data.js"></script>
  <script src="app.js"></script>
</body>
</html>
`, 'utf8')

  fs.writeFileSync(path.join(dir, 'README.md'), [
    `# ${tree.title || 'Target'} — captured GUI clone`,
    '',
    'Generated from `spec/ui-tree.json` and evidence `' + tree.evidence + '`.',
    'Open `index.html` in a browser. Tabs, menus, submenus and tree nodes are',
    'built from the real accessibility tree and can be toggled in the inspector.',
    '',
    'This is a structural and interaction clone of the observed GUI. It is not',
    'a binary replacement and does not implement application logic.',
    '',
  ].join('\n'), 'utf8')

  const manifest = {
    schema: 1,
    at: new Date().toISOString(),
    project: project.slug,
    title: tree.title,
    evidence: tree.evidence,
    source: 'spec/ui-tree.json',
    counts: tree.summary,
    verification: null,
    files: ['index.html', 'data.js', 'app.js', 'styles.css', 'README.md'],
  }
  const file = path.join(dir, 'manifest.json')
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  const verified = verifyGuiClone(workspace, slug)
  return {
    directory: relTo(paths.dir, dir),
    files: [...manifest.files, 'manifest.json'].map((f) => `clone/gui/${f}`),
    verification: verified.verification,
    counts: tree.summary,
  }
}

/** Re-count the generated data file and refuse to claim uncaptured coverage. */
export function verifyGuiClone(workspace, slug) {
  const paths = projectPaths(workspace, slug)
  const dir = path.join(paths.clone, 'gui')
  const manifestFile = path.join(dir, 'manifest.json')
  const dataFile = path.join(dir, 'data.js')
  if (!fs.existsSync(manifestFile) || !fs.existsSync(dataFile)) {
    return { status: 'unavailable', detail: 'No GUI clone generated yet' }
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  const text = fs.readFileSync(dataFile, 'utf8')
  const prefix = 'window.__GUI_TREE__ = '
  if (!text.startsWith(prefix)) throw new Error('GUI clone data.js has an unexpected format')
  const data = JSON.parse(text.slice(prefix.length).trim().replace(/;\s*$/, ''))
  const ids = new Set((data.nodes || []).map((n) => n.id).filter(Boolean))
  const total = (manifest.counts && manifest.counts.nodes) || 0
  const missing = (data.nodes || []).filter((n) => !n.id).map((n) => n.name || 'unnamed')
  const rendered = ids.size
  const completeness = total > 0 ? Number(Math.min(1, rendered / total).toFixed(4)) : 0
  manifest.verification = {
    checkedAt: new Date().toISOString(),
    totalNodes: total,
    representedNodes: rendered,
    renderedNodes: rendered,
    completeness,
    missing,
    evidence: data.evidence || null,
  }
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  return {
    status: completeness === 1 ? 'match' : 'changed',
    verification: manifest.verification,
    detail: `${rendered}/${total} captured nodes represented in the generated GUI clone`,
  }
}
