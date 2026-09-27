import * as THREE from 'three';
import { layerColourTexture, type LayerView } from '$lib/client/slicer/layer-view';

/** Colour by actual world Z, including both part and instance transforms. */
export function applyLayerColours(material: THREE.MeshStandardMaterial, view: LayerView) {
	const pixels = layerColourTexture(view);
	const texture = new THREE.DataTexture(pixels, pixels.length / 4, 1, THREE.RGBAFormat);
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.minFilter = texture.magFilter = THREE.LinearFilter;
	texture.needsUpdate = true;
	material.color.set(0xffffff);
	material.emissive.set(0);
	material.customProgramCacheKey = () => 'printlab-layer-height-v1';
	material.onBeforeCompile = (shader) => {
		shader.uniforms.printlabLayerColours = { value: texture };
		shader.uniforms.printlabLayerMinZ = { value: view.minZ };
		shader.uniforms.printlabLayerHeight = { value: Math.max(view.params.objectHeight, 0.0001) };
		shader.vertexShader = `varying float printlabWorldZ;\n${shader.vertexShader}`.replace(
			'#include <project_vertex>',
			'#include <project_vertex>\nprintlabWorldZ = (modelMatrix * vec4(transformed, 1.0)).z;'
		);
		shader.fragmentShader = `varying float printlabWorldZ;
uniform sampler2D printlabLayerColours;
uniform float printlabLayerMinZ;
uniform float printlabLayerHeight;
${shader.fragmentShader}`.replace(
			'#include <color_fragment>',
			`#include <color_fragment>
float printlabHeightFraction = clamp((printlabWorldZ - printlabLayerMinZ) / printlabLayerHeight, 0.0, 1.0);
diffuseColor.rgb = texture2D(printlabLayerColours, vec2(printlabHeightFraction, 0.5)).rgb;`
		);
	};
	material.addEventListener('dispose', () => texture.dispose());
}
