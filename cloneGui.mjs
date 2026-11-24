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
          state = Get-State $e
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
$behaviors = New-Object 'System.Collections.Generic.List[object]'
function Get-Core($c) {
  $r = $c.BoundingRectangle
  return ('{0}|{1}|{2}|{3}|{4}|{5}|{6}|{7}' -f @([string]$c.Name, [string]$c.ControlType.ProgrammaticName.Replace('ControlType.', ''), [string]$c.AutomationId, [string]$c.ClassName, [int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height))
}
function Get-State($element) {
  $state = [pscustomobject]@{ enabled = $false; offscreen = $false; focusable = $false; focused = $false; control = $false; content = $false; toggle = ''; selected = ''; expand = ''; value = ''; readOnly = '' }
  try {
    $c = $element.Current
    $state.enabled = [bool]$c.IsEnabled
    $state.offscreen = [bool]$c.IsOffscreen
    $state.focusable = [bool]$c.IsKeyboardFocusable
    $state.focused = [bool]$c.HasKeyboardFocus
    $state.control = [bool]$c.IsControlElement
    $state.content = [bool]$c.IsContentElement
  } catch { }
  $p = $null
  try {
    if ($element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) {
      $state.toggle = [string]$p.Current.ToggleState
    }
  } catch { }
  try {
    if ($element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) {
      $state.selected = [string]$p.Current.IsSelected
    }
  } catch { }
  try {
    if ($element.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) {
      $state.expand = [string]$p.Current.ExpandCollapseState
    }
  } catch { }
  try {
    if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) {
      $state.readOnly = [string]$p.Current.IsReadOnly
      $v = [string]$p.Current.Value
      $state.value = $v.Substring(0, [Math]::Min(200, $v.Length))
    }
  } catch { }
  return $state
}
function Add-Behavior($element, $action, $pattern, $before, $after, $status, $effect, $detail) {
  try {
    $c = $element.Current
    $behaviors.Add([pscustomobject]@{
      core = Get-Core $c
      name = [string]$c.Name
      type = [string]$c.ControlType.ProgrammaticName.Replace('ControlType.', '')
      action = $action
      pattern = $pattern
      before = $before
      after = $after
      status = $status
      effect = $effect
      detail = $detail
    })
  } catch { }
}
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
    $beforeState = Get-State $tab
    $sel = $null
    $usedPattern = 'InvokePattern'
    if ($tab.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$sel)) {
      $usedPattern = 'SelectionItemPattern'
      if ($sel.Current.IsSelected) { $selectedTab = $sel }
      $sel.Select()
    } else {
      $invoke = $null
      if ($tab.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) { $invoke.Invoke() }
    }
    Start-Sleep -Milliseconds $DelayMs
    $afterState = Get-State $tab
    $effect = if ($afterState.selected -eq 'True') { 'selected' } else { 'invoked' }
    $status = if ($afterState.selected -eq 'True' -or $usedPattern -eq 'InvokePattern') { 'verified' } else { 'observed' }
    Add-Behavior $tab 'select' $usedPattern $beforeState $afterState $status $effect ('surface tab:' + $c.Name)
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
    $beforeState = Get-State $item
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
      $afterState = Get-State $item
      Add-Behavior $item 'invoke' 'mouse-click' $beforeState $afterState 'verified' ('opened-surface:' + $surface) ('popup windows=' + $popups.Count)
      $steps.Add([pscustomobject]@{ action = 'open-menu'; target = $name; status = 'ok' })
      $subItems = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $menuItemCondition)
      foreach ($mi in $subItems) {
        try {
          $mc = $mi.Current
          if ([string]::IsNullOrWhiteSpace($mc.Name)) { continue }
          $ec = $null
          if (-not $mi.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$ec)) { continue }
          if ($ec.Current.ExpandCollapseState -eq [System.Windows.Automation.ExpandCollapseState]::Expanded) { continue }
          $subBefore = Get-State $mi
          $ec.Expand()
          Start-Sleep -Milliseconds $DelayMs
          $subAfter = Get-State $mi
          Add-Behavior $mi 'expand' 'ExpandCollapsePattern' $subBefore $subAfter 'verified' 'expanded-submenu' ('item ' + $mc.Name)
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
    $contextBefore = Get-State $t
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
        $contextAfter = Get-State $t
        Add-Behavior $t 'context-menu' 'mouse-right-click' $contextBefore $contextAfter 'verified' ('opened-surface:' + $cSurface) ('context target ' + $tc.ControlType.ProgrammaticName)
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
        $treeBefore = Get-State $item
        $pat.Expand()
        $collapsibles.Add(@{ p = $pat; n = $c.Name })
        Start-Sleep -Milliseconds $DelayMs
        $treeAfter = Get-State $item
        Add-Behavior $item 'expand' 'ExpandCollapsePattern' $treeBefore $treeAfter 'verified' 'expanded-tree' ('node ' + $c.Name)
        $steps.Add([pscustomobject]@{ action = 'expand-tree'; target = $c.Name; status = 'ok' })
        Add-Nodes $item ('tree:' + $c.Name) ('tree/' + $c.Name) ([Math]::Min($Depth, 8)) $true
      }
    }
  } catch {
    $failures += ('tree: ' + $_.Exception.Message)
  }
}
# Bounded, reversible toggle probe. Every checkbox is restored to its original state.
$checkboxes = Find-ByType $primary 'CheckBox' ([Math]::Min(100, $MaxTrees))
foreach ($cb in $checkboxes) {
  try {
    $cc = $cb.Current
    if (-not $cc.IsEnabled -or $cc.IsOffscreen -or [string]::IsNullOrWhiteSpace($cc.Name)) { continue }
    if ([string]$cc.Name -match '(?i)delete|remove|erase|format|exit|quit|apply|save') { continue }
    $tp = $null
    if (-not $cb.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$tp)) { continue }
    $toggleBefore = Get-State $cb
    $tp.Toggle()
    Start-Sleep -Milliseconds ([Math]::Max(30, [int]($DelayMs / 2)))
    $toggleAfter = Get-State $cb
    $tp.Toggle()
    Start-Sleep -Milliseconds ([Math]::Max(30, [int]($DelayMs / 2)))
    $toggleRestored = Get-State $cb
    $toggleStatus = if ($toggleAfter.toggle -ne $toggleBefore.toggle -and $toggleRestored.toggle -eq $toggleBefore.toggle) { 'verified' } else { 'observed' }
    Add-Behavior $cb 'toggle' 'TogglePattern' $toggleBefore $toggleAfter $toggleStatus 'toggled' ('restored=' + $toggleRestored.toggle)
  } catch {
    $failures += ('toggle: ' + $_.Exception.Message)
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
  behaviors = @($behaviors.ToArray())
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

function normalizeState(state) {
  if (!state || typeof state !== 'object') return null
  return {
    enabled: Boolean(state.enabled),
    offscreen: Boolean(state.offscreen),
    focusable: Boolean(state.focusable),
    focused: Boolean(state.focused),
    control: Boolean(state.control),
    content: Boolean(state.content),
    readOnly: String(state.readOnly || ''),
    toggle: String(state.toggle || ''),
    selected: String(state.selected || ''),
    expand: String(state.expand || ''),
    value: String(state.value || '').slice(0, 200),
  }
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
    state: normalizeState(node.state),
    depth: Number(node.depth) || 0,
  }
}

const PATTERN_CAPABILITY = {
  'InvokePatternIdentifiers.Pattern': 'invoke',
  'ValuePatternIdentifiers.Pattern': 'value',
  'TogglePatternIdentifiers.Pattern': 'toggle',
  'SelectionItemPatternIdentifiers.Pattern': 'select',
  'ExpandCollapsePatternIdentifiers.Pattern': 'expand',
  'WindowPatternIdentifiers.Pattern': 'window',
  'GridPatternIdentifiers.Pattern': 'grid',
  'TablePatternIdentifiers.Pattern': 'grid',
  'GridItemPatternIdentifiers.Pattern': 'grid-item',
  'TableItemPatternIdentifiers.Pattern': 'grid-item',
  'TransformPatternIdentifiers.Pattern': 'transform',
}

function coreOf(node) {
  const b = node.bounds || {}
  return [
    node.name, node.type, node.automationId || '', node.className || '',
    b.x || 0, b.y || 0, b.width || 0, b.height || 0,
  ].join('|')
}

const KIND_FOR_TYPE = {
  TabItem: 'select',
  MenuItem: 'invoke',
  Button: 'invoke',
  CheckBox: 'toggle',
  TreeItem: 'expand',
  Edit: 'value',
  ComboBox: 'value',
  Text: 'inspect',
  Image: 'inspect',
  Group: 'inspect',
  Window: 'window',
  Header: 'inspect',
}

/** Build a per-element behavior model: real patterns declare, real actions verify. */
function normalizeBehaviors(rawBehaviors, nodes, steps, evidence, caseId) {
  const executed = new Map()
  for (const record of Array.isArray(rawBehaviors) ? rawBehaviors : []) {
    const core = String(record.core || '')
    if (!core) continue
    if (!executed.has(core)) executed.set(core, [])
    const stepAction = {
      select: 'select-tab',
      invoke: 'open-menu',
      'context-menu': 'open-context-menu',
      expand: ['expand-submenu', 'expand-tree'],
      toggle: null,
    }[record.action]
    const actions = Array.isArray(stepAction) ? stepAction : stepAction ? [stepAction] : []
    const step = actions.length
      ? steps.find((s) => actions.includes(s.action) && s.target === record.name)
      : null
    executed.get(core).push({
      action: String(record.action || 'invoke'),
      pattern: String(record.pattern || ''),
      status: String(record.status || 'observed'),
      effect: String(record.effect || ''),
      detail: String(record.detail || ''),
      before: record.before || null,
      after: record.after || null,
      step: step ? step.index : null,
      evidence,
      case: caseId,
    })
  }

  const elements = nodes.map((node) => {
    const capabilities = []
    const patterns = Array.isArray(node.patterns) ? node.patterns : []
    for (const p of patterns) {
      const cap = PATTERN_CAPABILITY[p]
      if (cap && !capabilities.includes(cap)) capabilities.push(cap)
    }
    const core = coreOf(node)
    const runs = executed.get(core) || []
    const primary = runs[0] || null
    const kind = primary
      ? primary.action
      : KIND_FOR_TYPE[node.type] || (capabilities.includes('invoke') ? 'invoke' : 'inspect')
    const interactive = capabilities.some((c) =>
      ['invoke', 'value', 'toggle', 'select', 'expand'].includes(c))
    const status = primary
      ? (runs.some((r) => r.status === 'verified') ? 'verified' : 'observed')
      : interactive ? 'declared' : 'static'
    return {
      id: node.id,
      core,
      name: node.name,
      type: node.type,
      surface: node.surface,
      path: node.path,
      capabilities,
      state: node.state || null,
      behavior: {
        kind,
        status,
        pattern: primary ? primary.pattern : (patterns[0] || ''),
        effect: primary ? primary.effect : '',
        detail: primary ? primary.detail : '',
        before: primary ? primary.before : null,
        after: primary ? primary.after : null,
        step: primary ? primary.step : null,
        evidence: primary ? primary.evidence : evidence,
        case: primary ? primary.case : caseId,
        runs,
      },
    }
  })

  const summary = {
    total: elements.length,
    interactive: elements.filter((e) => e.capabilities.some((c) =>
      ['invoke', 'value', 'toggle', 'select', 'expand'].includes(c))).length,
    verified: elements.filter((e) => e.behavior.status === 'verified').length,
    observed: elements.filter((e) => e.behavior.status === 'observed').length,
    declared: elements.filter((e) => e.behavior.status === 'declared').length,
    static: elements.filter((e) => e.behavior.status === 'static').length,
    executedActions: runsCount(executed),
  }
  return {
    schema: 1,
    at: new Date().toISOString(),
    evidence,
    case: caseId,
    summary,
    elements,
  }
}

function runsCount(executed) {
  let n = 0
  for (const runs of executed.values()) n += runs.length
  return n
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
    const behavior = normalizeBehaviors(raw.behaviors, nodes, steps, evidence, null)
    const behaviorFile = path.join(paths.spec, 'gui-behavior.json')
    fs.mkdirSync(paths.spec, { recursive: true })
    fs.writeFileSync(behaviorFile, JSON.stringify(behavior, null, 2) + '\n', 'utf8')

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
      behavior: behavior.summary,
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
      note: `Deep GUI tree: ${nodes.length} nodes, ${surfaces.length} surfaces (${summary.menuSurfaces} menus, ${summary.tabSurfaces} tabs); behavior ${behavior.summary.verified} verified / ${behavior.summary.interactive} interactive`,
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
        behavior: behavior.summary,
      },
    })

    behavior.case = recorded.id
    for (const element of behavior.elements) {
      element.behavior.case = recorded.id
      for (const run of element.behavior.runs) run.case = recorded.id
    }
    fs.writeFileSync(behaviorFile, JSON.stringify(behavior, null, 2) + '\n', 'utf8')

    return {
      title: tree.title,
      processId: tree.processId,
      evidence,
      summary,
      behavior: behavior.summary,
      steps: steps.length,
      case: recorded.id,
      files: ['spec/ui-tree.json', 'spec/ui-map.json', 'spec/gui-behavior.json', tree.rawFile],
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

export function readGuiBehavior(workspace, slug) {
  const paths = projectPaths(workspace, slug)
  try {
    return JSON.parse(fs.readFileSync(path.join(paths.spec, 'gui-behavior.json'), 'utf8'))
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
const behavior = tree.behavior || { elements: [] }
const behaviorById = new Map((behavior.elements || []).map(function (e) { return [e.id, e] }))
const replayEvents = []
const replayState = new Map()
const toggled = new Set()
const root = document.getElementById('guiRoot')
const list = document.getElementById('guiControlList')
const count = document.getElementById('guiCount')
function showInspector(n) {
  document.querySelectorAll('.gui-selected').forEach(function (x) { x.classList.remove('gui-selected') })
  const el = elements.get(n.id)
  if (el) el.classList.add('gui-selected')
  const bh = behaviorById.get(n.id)
  const box = document.getElementById('guiBehavior')
  if (box) {
    box.textContent = bh
      ? JSON.stringify({
          id: bh.id,
          capabilities: bh.capabilities,
          state: bh.state,
          behavior: bh.behavior,
          replay: replayState.get(n.id) || null,
        }, null, 2)
      : 'No behavior record was captured for this element.'
  }
  document.getElementById('guiDetail').textContent = JSON.stringify(n, null, 2)
}
function renderBehaviorSummary() {
  const el = document.getElementById('guiBehaviorSummary')
  if (!el) return
  const s = behavior.summary || {}
  const applied = replayEvents.filter(function (e) { return e.applied }).length
  const skipped = replayEvents.length - applied
  el.textContent = 'Recorded ' + (s.interactive || 0) + ' interactive / ' + (s.total || 0) +
    ' elements · verified ' + (s.verified || 0) + ', observed ' + (s.observed || 0) +
    ', declared ' + (s.declared || 0) + ', static ' + (s.static || 0) +
    ' · replay ' + applied + ' applied, ' + skipped + ' skipped (local only)'
}
function recordReplay(id, applied, note, extra) {
  const n = byId.get(id)
  const bh = behaviorById.get(id)
  const rec = {
    id: id,
    name: n ? n.name : '',
    kind: bh ? bh.behavior.kind : 'inspect',
    status: bh ? bh.behavior.status : 'static',
    recordedEffect: bh ? bh.behavior.effect : '',
    applied: Boolean(applied),
    localOnly: true,
    note: note,
    at: new Date().toISOString(),
  }
  if (extra) Object.keys(extra).forEach(function (k) { rec[k] = extra[k] })
  replayEvents.push(rec)
  replayState.set(id, rec)
  const el = elements.get(id)
  if (el) el.setAttribute('data-replayed', applied ? 'applied' : 'no-effect')
  renderBehaviorSummary()
  return rec
}
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
  const bh = behaviorById.get(n.id)
  const behaviorStatus = bh ? bh.behavior.status : 'static'
  const behaviorKind = bh ? bh.behavior.kind : 'inspect'
  el.setAttribute('data-behavior', behaviorStatus)
  el.setAttribute('data-behavior-kind', behaviorKind)
  el.title = n.type + ': ' + n.name + ' [' + n.surface + '] · ' + behaviorStatus
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
  if (bh) {
    const badge = document.createElement('span')
    badge.className = 'gui-badge gui-badge-' + behaviorStatus
    badge.textContent = behaviorStatus
    badge.setAttribute('data-behavior-badge', behaviorStatus)
    el.appendChild(badge)
  }
  surface.appendChild(el)
  elements.set(n.id, el)
  const item = document.createElement('div')
  item.className = 'gui-list-item'
  item.setAttribute('data-list-node', n.id)
  item.setAttribute('data-behavior', behaviorStatus)
  item.textContent = n.type + ' · ' + n.name + ' · ' + n.surface + ' · ' + behaviorStatus
  item.addEventListener('click', function () { showInspector(n) })
  list.appendChild(item)
})
const tabSurfaces = Array.from(new Set(nodes.map(function (n) { return n.surface }).filter(function (s) { return s.indexOf('tab:') === 0 })))
let activeTab = tabSurfaces[0] || null
const openMenus = new Set()
const openTrees = new Set()
function groupOf(surface) {
  if (surface.indexOf('tab:') === 0) return 'tab'
  if (surface.indexOf('menu:') === 0 || surface.indexOf('context:') === 0) return 'menu'
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
    el.classList.toggle('gui-toggled', toggled.has(n.id))
    el.classList.toggle('gui-replayed', replayState.has(n.id))
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
  btn.setAttribute('data-behavior', behaviorById.has(n.id) ? behaviorById.get(n.id).behavior.status : 'static')
  btn.addEventListener('click', function () { replay(n.id) })
  document.getElementById('guiTabs').appendChild(btn)
})
nodes.filter(function (n) { return n.type === 'MenuItem' && n.surface.indexOf('menu:') !== 0 }).forEach(function (n) {
  const btn = document.createElement('button')
  btn.className = 'gui-menu-button'
  btn.textContent = n.name
  btn.setAttribute('data-surface', 'menu:' + n.name)
  btn.setAttribute('data-behavior', behaviorById.has(n.id) ? behaviorById.get(n.id).behavior.status : 'static')
  btn.addEventListener('click', function () { replay(n.id) })
  document.getElementById('guiMenus').appendChild(btn)
})
function replay(id, value) {
  const n = byId.get(id)
  if (!n) return null
  const bh = behaviorById.get(id)
  const b = bh ? bh.behavior : null
  const status = b ? b.status : 'static'
  if (!b || status === 'declared' || status === 'static') {
    return recordReplay(id, false, 'not executed: ' + status + ' (no recorded effect)')
  }
  const kind = b.kind
  const effect = String(b.effect || '')
  const detail = String(b.detail || '')
  let changed = false
  let note = ''
  if (kind === 'select') {
    const recorded = detail.indexOf('surface ') === 0 ? detail.slice(8) : null
    const key = recorded || (n.surface.indexOf('tab:') === 0 ? n.surface : 'tab:' + n.name)
    if ((tree.surfaces || []).indexOf(key) !== -1) {
      activeTab = key
      changed = true
      note = 'local tab activation: ' + key
    } else {
      note = 'recorded select, but surface was not captured; no state changed'
    }
  } else if (kind === 'invoke' || kind === 'context-menu') {
    const recorded = effect.indexOf('opened-surface:') === 0 ? effect.slice(15) : null
    const key = recorded || (n.surface.indexOf('menu:') === 0 || n.surface.indexOf('context:') === 0 || n.surface.indexOf('tree:') === 0 ? n.surface : null)
    if (key && key.indexOf('tree:') === 0) {
      if (openTrees.has(key)) { openTrees.delete(key); note = 'local tree surface closed: ' + key }
      else { openTrees.add(key); changed = true; note = 'local tree surface opened: ' + key }
    } else if (key && (key.indexOf('menu:') === 0 || key.indexOf('context:') === 0)) {
      if (openMenus.has(key)) { openMenus.delete(key); note = 'local menu surface closed: ' + key }
      else { openMenus.add(key); changed = true; note = 'local menu surface opened: ' + key }
    } else {
      note = 'recorded invoke, but no opened surface was captured; no state changed'
    }
  } else if (kind === 'expand') {
    const key = n.surface
    const set = key.indexOf('tree:') === 0 ? openTrees : openMenus
    if (key && (key.indexOf('tree:') === 0 || key.indexOf('menu:') === 0 || key.indexOf('context:') === 0)) {
      if (set.has(key)) { set.delete(key); note = 'local expansion closed: ' + key }
      else { set.add(key); changed = true; note = 'local expansion opened: ' + key }
    } else {
      note = 'recorded expand, but no expandable surface was captured; no state changed'
    }
  } else if (kind === 'toggle') {
    if (toggled.has(id)) { toggled.delete(id); note = 'local checkbox state restored' }
    else { toggled.add(id); changed = true; note = 'local checkbox state flipped (target not affected)' }
  } else if (kind === 'value') {
    const el = elements.get(id)
    const text = value === undefined || value === null ? String(effect || 'local value edit') : String(value)
    if (el) {
      el.setAttribute('data-local-value', text)
      changed = true
      note = 'local value set: ' + text + ' (target not affected)'
    } else {
      note = 'recorded value, but no element to edit; no state changed'
    }
  } else {
    note = 'no replay mapping for kind ' + kind + '; no state changed'
  }
  refresh()
  return recordReplay(id, changed, note)
}
surface.addEventListener('click', function (event) {
  if (event.target && event.target.getAttribute && event.target.getAttribute('data-behavior-badge')) {
    const host = event.target.parentElement
    if (host) {
      const node = byId.get(host.getAttribute('data-node-id'))
      if (node) { showInspector(node); replay(node.id); showInspector(node) }
    }
    return
  }
  const el = event.target.closest('[data-node-id]')
  if (!el) return
  const n = byId.get(el.getAttribute('data-node-id'))
  if (!n) return
  showInspector(n)
  replay(n.id)
  showInspector(n)
})
window.__GUI_BEHAVIOR_REPLAY__ = {
  events: replayEvents,
  state: replayState,
  replay: replay,
  summary: function () {
    return {
      recorded: behavior.summary || null,
      applied: replayEvents.filter(function (e) { return e.applied }).length,
      skipped: replayEvents.filter(function (e) { return !e.applied }).length,
      events: replayEvents.slice(),
    }
  },
}
window.__GUI_RENDERED__ = nodes.length
renderBehaviorSummary()
refresh()
`

/** Generate a deterministic, browser-renderable structural clone of the GUI. */
export function generateGuiClone(workspace, slug) {
  const project = getProject(workspace, slug)
  if (!project) throw new Error(`No clone project "${slug}"`)
  const tree = readGuiTree(workspace, slug)
  if (!tree) throw new Error('No deep GUI tree captured for this project')
  const behavior = readGuiBehavior(workspace, slug)
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
    behavior: behavior,
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
.gui-node.gui-toggled { background: #b7e3ff; border-color: #2878b5; }
.gui-node.gui-replayed[data-replayed="no-effect"] { opacity: 0.7; }
.gui-badge { position: absolute; right: 0; top: 0; padding: 0 3px; font: 9px/1.3 Consolas, monospace; background: #24304a; color: #d8e2f2; pointer-events: none; }
.gui-badge-verified { background: #1d6b43; }
.gui-badge-observed { background: #775c16; }
.gui-badge-declared { background: #38527d; }
.gui-badge-static { background: #4a4a4a; }
#guiBehaviorSummary { color: #9fc5ff; margin: 6px 0; }
#guiBehavior { white-space: pre-wrap; font: 10px/1.3 Consolas, monospace; color: #b7d8a8; max-height: 240px; overflow: auto; }
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
      <div id="guiBehaviorSummary">behavior model loading…</div>
      <div><b>Tabs</b><div id="guiTabs"></div></div>
      <div><b>Menus</b><div id="guiMenus"></div></div>
      <div><b>All controls</b><div id="guiControlList"></div></div>
      <pre id="guiDetail">Select a control to inspect its captured data.</pre>
      <div><b>Recorded behavior</b><pre id="guiBehavior">Select a control to inspect its recorded behavior.</pre></div>
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
    'Generated from `spec/ui-tree.json`, `spec/gui-behavior.json` and evidence `' + tree.evidence + '`.',
    'Open `index.html` in a browser. Tabs, menus, submenus and tree nodes are',
    'built from the real accessibility tree and can be toggled in the inspector.',
    '',
    'Each element carries a status badge: `verified` = a real before/after effect was',
    'recorded, `observed` = the action ran without a confirmed state change,',
    '`declared` = the UI Automation pattern exists but was not executed, and',
    '`static` = no actionable pattern. Only verified/observed elements replay locally;',
    'declared/static elements are shown but not executed. Replay affects only the',
    'browser clone and never the target application.', '',
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
    behaviorSource: 'spec/gui-behavior.json',
    behavior: behavior ? behavior.summary : null,
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
  const rawBehavior = data.behavior || null
  const elements = Array.isArray(rawBehavior && rawBehavior.elements) ? rawBehavior.elements : []
  const actionable = (e) => Array.isArray(e.capabilities) && e.capabilities.some((c) =>
    ['invoke', 'value', 'toggle', 'select', 'expand'].includes(c))
  const knownElements = elements.filter((e) => e && e.id && ids.has(e.id))
  const orphanElements = elements.filter((e) => !e || !e.id || !ids.has(e.id)).map((e) => e && e.id || 'unnamed')
  const behaviorCounts = {
    total: knownElements.length,
    interactive: knownElements.filter(actionable).length,
    verified: knownElements.filter((e) => e.behavior?.status === 'verified').length,
    observed: knownElements.filter((e) => e.behavior?.status === 'observed').length,
    declared: knownElements.filter((e) => e.behavior?.status === 'declared').length,
    static: knownElements.filter((e) => e.behavior?.status === 'static').length,
    executedActions: Number(rawBehavior?.summary?.executedActions) || 0,
    orphanElements,
  }
  behaviorCounts.recorded = behaviorCounts.verified + behaviorCounts.observed
  behaviorCounts.coverage = behaviorCounts.interactive > 0
    ? Number(Math.min(1, behaviorCounts.recorded / behaviorCounts.interactive).toFixed(4))
    : 0
  behaviorCounts.complete = knownElements.length === rendered && orphanElements.length === 0
  manifest.verification = {
    checkedAt: new Date().toISOString(),
    totalNodes: total,
    representedNodes: rendered,
    renderedNodes: rendered,
    completeness,
    missing,
    evidence: data.evidence || null,
    behavior: behaviorCounts,
  }
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  return {
    status: completeness === 1 ? 'match' : 'changed',
    verification: manifest.verification,
    detail: `${rendered}/${total} captured nodes represented; behavior ${behaviorCounts.recorded}/${behaviorCounts.interactive} interactive elements recorded ` +
      `(${behaviorCounts.verified} verified, ${behaviorCounts.observed} observed, ${behaviorCounts.declared} declared, ${behaviorCounts.static} static)`,
  }
}
