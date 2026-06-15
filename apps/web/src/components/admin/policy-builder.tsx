'use client';

import * as React from 'react';
import {
  type PolicyBuilderNode,
  type BadgeBuilderNode,
  type CompositeBuilderNode,
  type AtLeastBuilderNode,
  KNOWN_BADGE_TYPES,
  makeAllOf,
  makeAnyOf,
  makeAtLeast,
  makeBadge,
} from '@/lib/policy-builder';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

// ---- Node mutators ----------------------------------------------------------

/**
 * Immutably update a node anywhere in the tree by id.
 */
function updateNodeById(
  root: PolicyBuilderNode,
  id: string,
  update: (n: PolicyBuilderNode) => PolicyBuilderNode,
): PolicyBuilderNode {
  if (root.id === id) return update(root);

  if (root.kind === 'allOf' || root.kind === 'anyOf') {
    return {
      ...root,
      children: root.children.map((c) => updateNodeById(c, id, update)),
    };
  }

  if (root.kind === 'atLeast') {
    return {
      ...root,
      children: root.children.map((c) => updateNodeById(c, id, update)),
    };
  }

  return root;
}

/**
 * Add a child to a composite/atLeast node by parent id.
 */
function addChildById(
  root: PolicyBuilderNode,
  parentId: string,
  child: PolicyBuilderNode,
): PolicyBuilderNode {
  return updateNodeById(root, parentId, (n) => {
    if (n.kind === 'badge') return n;
    return { ...n, children: [...n.children, child] };
  });
}

/**
 * Remove a child from a composite/atLeast node by parent id and child id.
 */
function removeChildById(
  root: PolicyBuilderNode,
  parentId: string,
  childId: string,
): PolicyBuilderNode {
  return updateNodeById(root, parentId, (n) => {
    if (n.kind === 'badge') return n;
    return { ...n, children: n.children.filter((c) => c.id !== childId) };
  });
}

// ---- Sub-components ---------------------------------------------------------

interface NodeProps {
  node: PolicyBuilderNode;
  parentId: string | null;
  depth: number;
  onUpdate: (id: string, updater: (n: PolicyBuilderNode) => PolicyBuilderNode) => void;
  onAddChild: (parentId: string, child: PolicyBuilderNode) => void;
  onRemove: (parentId: string, childId: string) => void;
}

function BadgeNodeEditor({
  node,
  parentId,
  onUpdate,
  onRemove,
}: NodeProps & { node: BadgeBuilderNode }) {
  function set<K extends keyof BadgeBuilderNode>(key: K, value: BadgeBuilderNode[K]) {
    onUpdate(node.id, (n) => ({ ...n, [key]: value }));
  }

  function setWhereKey(idx: number, key: string) {
    const where = [...node.where];
    where[idx] = { ...where[idx], key };
    set('where', where);
  }

  function setWhereValue(idx: number, value: string) {
    const where = [...node.where];
    where[idx] = { ...where[idx], value };
    set('where', where);
  }

  function addWhere() {
    set('where', [...node.where, { key: '', value: '' }]);
  }

  function removeWhere(idx: number) {
    set(
      'where',
      node.where.filter((_, i) => i !== idx),
    );
  }

  return (
    <div className="rounded border border-border bg-muted/30 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          badge
        </span>
        {parentId !== null && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-destructive"
            onClick={() => onRemove(parentId, node.id)}
          >
            remove
          </Button>
        )}
      </div>

      <div className="grid gap-2">
        <div>
          <Label className="mb-1 block text-xs">badge type</Label>
          <Select value={node.badgeType} onValueChange={(v) => set('badgeType', v)}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KNOWN_BADGE_TYPES.map((t) => (
                <SelectItem key={t} value={t} className="text-xs">
                  {t}
                </SelectItem>
              ))}
              {!KNOWN_BADGE_TYPES.includes(node.badgeType as (typeof KNOWN_BADGE_TYPES)[number]) && (
                <SelectItem value={node.badgeType} className="text-xs">
                  {node.badgeType}
                </SelectItem>
              )}
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label className="mb-1 block text-xs">maxAgeDays (optional)</Label>
          <Input
            className="h-8 text-xs"
            type="number"
            min={1}
            placeholder="unlimited"
            value={node.maxAgeDays}
            onChange={(e) => set('maxAgeDays', e.target.value)}
          />
        </div>

        {node.where.length > 0 && (
          <div>
            <Label className="mb-1 block text-xs">where constraints</Label>
            <div className="grid gap-1">
              {node.where.map((entry, idx) => (
                <div key={idx} className="flex items-center gap-1">
                  <Input
                    className="h-7 flex-1 text-xs"
                    placeholder="attribute"
                    value={entry.key}
                    onChange={(e) => setWhereKey(idx, e.target.value)}
                  />
                  <span className="text-xs text-muted-foreground">=</span>
                  <Input
                    className="h-7 flex-1 text-xs"
                    placeholder="value"
                    value={entry.value}
                    onChange={(e) => setWhereValue(idx, e.target.value)}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-1.5 text-xs text-destructive"
                    onClick={() => removeWhere(idx)}
                  >
                    x
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={addWhere}
        >
          + add where constraint
        </Button>
      </div>
    </div>
  );
}

function CompositeNodeEditor({
  node,
  parentId,
  depth,
  onUpdate,
  onAddChild,
  onRemove,
}: NodeProps & { node: CompositeBuilderNode }) {
  const label = node.kind === 'allOf' ? 'ALL OF (and)' : 'ANY OF (or)';

  return (
    <div className="rounded border border-border bg-card p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide">
          {label}
        </span>
        {parentId !== null && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-destructive"
            onClick={() => onRemove(parentId, node.id)}
          >
            remove
          </Button>
        )}
      </div>

      {node.children.length > 0 && (
        <div className={`mb-2 grid gap-2 ${depth > 0 ? 'pl-3' : ''}`}>
          {node.children.map((child) => (
            <PolicyNodeEditor
              key={child.id}
              node={child}
              parentId={node.id}
              depth={depth + 1}
              onUpdate={onUpdate}
              onAddChild={onAddChild}
              onRemove={onRemove}
            />
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() => onAddChild(node.id, makeBadge())}
        >
          + badge
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() => onAddChild(node.id, makeAllOf())}
        >
          + allOf
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() => onAddChild(node.id, makeAnyOf())}
        >
          + anyOf
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() => onAddChild(node.id, makeAtLeast())}
        >
          + atLeast
        </Button>
      </div>
    </div>
  );
}

function AtLeastNodeEditor({
  node,
  parentId,
  depth,
  onUpdate,
  onAddChild,
  onRemove,
}: NodeProps & { node: AtLeastBuilderNode }) {
  return (
    <div className="rounded border border-border bg-card p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide">AT LEAST</span>
        <Input
          className="h-7 w-16 text-xs"
          type="number"
          min={0}
          value={node.n}
          onChange={(e) =>
            onUpdate(node.id, (n) => ({ ...n, n: e.target.value }))
          }
        />
        <span className="text-xs text-muted-foreground">of</span>
        {parentId !== null && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto h-6 px-2 text-xs text-destructive"
            onClick={() => onRemove(parentId, node.id)}
          >
            remove
          </Button>
        )}
      </div>

      {node.children.length > 0 && (
        <div className={`mb-2 grid gap-2 ${depth > 0 ? 'pl-3' : ''}`}>
          {node.children.map((child) => (
            <PolicyNodeEditor
              key={child.id}
              node={child}
              parentId={node.id}
              depth={depth + 1}
              onUpdate={onUpdate}
              onAddChild={onAddChild}
              onRemove={onRemove}
            />
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() => onAddChild(node.id, makeBadge())}
        >
          + badge
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() => onAddChild(node.id, makeAllOf())}
        >
          + allOf
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() => onAddChild(node.id, makeAnyOf())}
        >
          + anyOf
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() => onAddChild(node.id, makeAtLeast())}
        >
          + atLeast
        </Button>
      </div>
    </div>
  );
}

function PolicyNodeEditor(props: NodeProps) {
  const { node } = props;
  if (node.kind === 'badge') return <BadgeNodeEditor {...props} node={node} />;
  if (node.kind === 'allOf' || node.kind === 'anyOf') return <CompositeNodeEditor {...props} node={node} />;
  // node.kind === 'atLeast'
  return <AtLeastNodeEditor {...props} node={node as AtLeastBuilderNode} />;
}

// ---- Top-level component ----------------------------------------------------

export interface PolicyBuilderProps {
  root: PolicyBuilderNode;
  onChange: (root: PolicyBuilderNode) => void;
}

export function PolicyBuilder({ root, onChange }: PolicyBuilderProps) {
  function handleUpdate(
    id: string,
    updater: (n: PolicyBuilderNode) => PolicyBuilderNode,
  ) {
    onChange(updateNodeById(root, id, updater));
  }

  function handleAddChild(parentId: string, child: PolicyBuilderNode) {
    onChange(addChildById(root, parentId, child));
  }

  function handleRemove(parentId: string, childId: string) {
    onChange(removeChildById(root, parentId, childId));
  }

  return (
    <PolicyNodeEditor
      node={root}
      parentId={null}
      depth={0}
      onUpdate={handleUpdate}
      onAddChild={handleAddChild}
      onRemove={handleRemove}
    />
  );
}
