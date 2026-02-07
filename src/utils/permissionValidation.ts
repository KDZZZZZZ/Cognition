/**
 * Permission validation utilities
 * Ensures Agent's actual permissions and visible file list align with frontend permission state
 */

import { Permission } from '../types';

/**
 * Validates that contextFiles list matches the given permissions
 * Returns a filtered list containing only files with read or write permissions
 */
export function validateContextFiles(
  contextFiles: string[],
  permissions: Record<string, Permission>
): string[] {
  return contextFiles.filter(fileId => {
    const perm = permissions[fileId] || 'read';
    return perm !== 'none';
  });
}

/**
 * Gets the list of visible files (files with read or write permission)
 */
export function getVisibleFiles(
  allFileIds: string[],
  permissions: Record<string, Permission>
): string[] {
  return allFileIds.filter(fileId => {
    const perm = permissions[fileId] || 'read';
    return perm !== 'none';
  });
}

/**
 * Gets the list of writable files (files with write permission)
 */
export function getWritableFiles(
  allFileIds: string[],
  permissions: Record<string, Permission>
): string[] {
  return allFileIds.filter(fileId => {
    const perm = permissions[fileId] || 'read';
    return perm === 'write';
  });
}

/**
 * Checks if a file has the specified permission level or higher
 * Permission hierarchy: none < read < write
 */
export function hasPermissionOrHigher(
  fileId: string,
  permissions: Record<string, Permission>,
  requiredLevel: Permission
): boolean {
  const current = permissions[fileId] || 'read';

  if (requiredLevel === 'none') return true;
  if (requiredLevel === 'read') return current === 'read' || current === 'write';
  if (requiredLevel === 'write') return current === 'write';

  return false;
}

/**
 * Builds the context files payload for API requests
 * Ensures alignment between frontend permissions and what's sent to backend
 */
export function buildContextFilesPayload(
  allFileIds: string[],
  permissions: Record<string, Permission>
): { contextFiles: string[]; writableFiles: string[] } {
  const visibleFiles = getVisibleFiles(allFileIds, permissions);
  const writableFiles = getWritableFiles(allFileIds, permissions);

  return {
    contextFiles: visibleFiles,
    writableFiles,
  };
}

/**
 * Permission mismatch detector
 * Returns true if there's a mismatch between frontend and backend permission states
 */
export function detectPermissionMismatch(
  frontendPermissions: Record<string, Permission>,
  backendPermissions: Record<string, Permission>
): { hasMismatch: boolean; mismatchedFiles: Array<{ fileId: string; frontend: Permission; backend: Permission }> } {
  const allFileIds = new Set([...Object.keys(frontendPermissions), ...Object.keys(backendPermissions)]);
  const mismatchedFiles: Array<{ fileId: string; frontend: Permission; backend: Permission }> = [];

  for (const fileId of allFileIds) {
    const frontend = frontendPermissions[fileId] || 'read';
    const backend = backendPermissions[fileId] || 'read';

    if (frontend !== backend) {
      mismatchedFiles.push({ fileId, frontend, backend });
    }
  }

  return {
    hasMismatch: mismatchedFiles.length > 0,
    mismatchedFiles,
  };
}
