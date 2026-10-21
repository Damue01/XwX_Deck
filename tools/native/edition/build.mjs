import {assertPublicBinary} from '../public-binary-boundary.mjs';
export const editionBuild={nativeBinary:'xwx-deck-native',helperBinary:'xwxdeck-update-helper',automaticMacUpdate:false,noticesFile:'docs/licenses/third-party-notices.md',macOutput:'release-native',macArtifact:arch=>'XwX-Deck-mac-'+arch+'.dmg',backgroundScript:'tools/icons/generate-macos-dmg-background.swift'};
export const assertEditionArtifact=assertPublicBinary;
