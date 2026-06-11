/**
 * Blocks.js — the 8 voxel block definitions for Magic World's build mode.
 *
 * Named exports (per docs/CONTRACTS.md):
 *   - BLOCKS            : array of exactly 8 block defs (slot order = hotbar keys 1–8)
 *   - getBlockMaterial  : cached shared MeshStandardMaterial per block id
 *   - BLOCK_GEOMETRY    : one shared unit BoxGeometry reused by every block mesh
 *
 * Design source: docs/design/building.md §1 — colors, emissive, roughness/metalness
 * values are exact. All materials are flat-shaded MeshStandardMaterial; transparent
 * materials disable depthWrite and render front faces only so crystal towers and
 * glass walls layer cleanly over the world without sorting artifacts.
 *
 * Performance: one geometry + one material per block type, shared by every placed
 * block mesh in the world. Nothing here allocates per frame.
 */

import * as THREE from 'three';

/**
 * The 8 block types, in hotbar order (slots 1–8).
 * Each def: { id, name, color, emissive, emissiveIntensity, transparent, opacity, roughness, metalness }
 * Colors are exact values from the building design spec.
 */
export const BLOCKS = Object.freeze([
  Object.freeze({
    id: 'stone',
    name: 'Stone',
    color: 0x8a8f98,
    emissive: 0x000000,
    emissiveIntensity: 0.0,
    transparent: false,
    opacity: 1.0,
    roughness: 0.95,
    metalness: 0.05,
  }),
  Object.freeze({
    id: 'wood',
    name: 'Wood',
    color: 0x8b5a2b,
    emissive: 0x000000,
    emissiveIntensity: 0.0,
    transparent: false,
    opacity: 1.0,
    roughness: 0.85,
    metalness: 0.0,
  }),
  Object.freeze({
    id: 'marble',
    name: 'Marble',
    color: 0xf2eee4,
    emissive: 0x000000,
    emissiveIntensity: 0.0,
    transparent: false,
    opacity: 1.0,
    roughness: 0.35,
    metalness: 0.0,
  }),
  Object.freeze({
    id: 'gold',
    name: 'Gold',
    color: 0xffc94d,
    emissive: 0x000000,
    emissiveIntensity: 0.0,
    transparent: false,
    opacity: 1.0,
    roughness: 0.25,
    metalness: 0.85,
  }),
  Object.freeze({
    id: 'crystal',
    name: 'Crystal',
    color: 0x7df3ff,
    emissive: 0x22e0ff,
    emissiveIntensity: 0.9,
    transparent: true,
    opacity: 0.6,
    roughness: 0.1,
    metalness: 0.0,
  }),
  Object.freeze({
    id: 'leaf',
    name: 'Leaf',
    color: 0x3fae4a,
    emissive: 0x000000,
    emissiveIntensity: 0.0,
    transparent: false,
    opacity: 1.0,
    roughness: 0.9,
    metalness: 0.0,
  }),
  Object.freeze({
    id: 'lava',
    name: 'Lava',
    color: 0xff5a1f,
    emissive: 0xff6a00,
    emissiveIntensity: 1.4,
    transparent: false,
    opacity: 1.0,
    roughness: 0.7,
    metalness: 0.0,
  }),
  Object.freeze({
    id: 'glass',
    name: 'Glass',
    color: 0xbfe8ff,
    emissive: 0x000000,
    emissiveIntensity: 0.0,
    transparent: true,
    opacity: 0.35,
    roughness: 0.05,
    metalness: 0.0,
  }),
]);

/** Fast id → def lookup (also handy for consumers; built once at module load). */
const BLOCK_BY_ID = new Map(BLOCKS.map((def) => [def.id, def]));

/** Material cache: block id → shared MeshStandardMaterial. */
const materialCache = new Map();

/**
 * Returns the shared, cached MeshStandardMaterial for a block id.
 * The SAME material instance is returned for every call with the same id —
 * thousands of placed blocks share 8 materials total, keeping GPU state
 * switches and shader compiles to a minimum.
 *
 * Unknown ids (typo'd prefab data, corrupted saves) log a console.error once
 * per bad id and fall back to the first block's material — degrade visibly,
 * never crash world loading mid-frame.
 *
 * @param {string} id — one of: stone, wood, marble, gold, crystal, leaf, lava, glass
 * @returns {THREE.MeshStandardMaterial}
 */
export function getBlockMaterial(id) {
  let material = materialCache.get(id);
  if (material) return material;

  let def = BLOCK_BY_ID.get(id);
  if (!def) {
    console.error(`[Blocks] unknown block id "${id}" — valid ids: ${BLOCKS.map((b) => b.id).join(', ')}. Falling back to "${BLOCKS[0].id}".`);
    def = BLOCKS[0];
    material = getBlockMaterial(def.id);
    materialCache.set(id, material); // cache the alias so the error logs once per bad id
    return material;
  }

  material = new THREE.MeshStandardMaterial({
    name: `block-${def.id}`,
    color: def.color,
    emissive: def.emissive,
    emissiveIntensity: def.emissiveIntensity,
    roughness: def.roughness,
    metalness: def.metalness,
    flatShading: true,
  });

  if (def.transparent) {
    // Translucent blocks (crystal, glass): no depth write so blocks behind
    // still render through them, front faces only to avoid double-draw
    // sorting artifacts on the shared cube geometry.
    material.transparent = true;
    material.opacity = def.opacity;
    material.depthWrite = false;
    material.side = THREE.FrontSide;
  }

  materialCache.set(id, material);
  return material;
}

/**
 * One shared unit cube geometry for every placed block in the world.
 * BuildSystem positions block meshes at cell centers (x+0.5, y+0.5, z+0.5)
 * and scales for pop-in animations — the geometry itself is never mutated.
 */
export const BLOCK_GEOMETRY = new THREE.BoxGeometry(1, 1, 1);
