import * as path from 'path';

export function assetPath(fileName: string): string {
  return path.join(__dirname, '..', 'assets', fileName);
}
