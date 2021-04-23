import { BaseTransitionProps } from '@vue/runtime-core';
import { CreateAppFunction } from '@vue/runtime-core';
import { FunctionalComponent } from '@vue/runtime-core';
import { ObjectDirective } from '@vue/runtime-core';
import { RootHydrateFunction } from '@vue/runtime-core';
import { RootRenderFunction } from '@vue/runtime-core';

declare const ANIMATION = "animation";

declare type AssignerFn = (value: any) => void;

export declare const createApp: CreateAppFunction<Element>;

export declare const createSSRApp: CreateAppFunction<Element>;

export declare const hydrate: RootHydrateFunction;

declare type ModelDirective<T> = ObjectDirective<T & {
    _assign: AssignerFn;
}>;

export declare const render: RootRenderFunction<Element>;

declare const TRANSITION = "transition";

export declare const Transition: FunctionalComponent<TransitionProps>;

export declare const TransitionGroup: new () => {
    $props: TransitionGroupProps;
};

export declare type TransitionGroupProps = Omit<TransitionProps, 'mode'> & {
    tag?: string;
    moveClass?: string;
};

export declare interface TransitionProps extends BaseTransitionProps<Element> {
    name?: string;
    type?: typeof TRANSITION | typeof ANIMATION;
    css?: boolean;
    duration?: number | {
        enter: number;
        leave: number;
    };
    enterFromClass?: string;
    enterActiveClass?: string;
    enterToClass?: string;
    appearFromClass?: string;
    appearActiveClass?: string;
    appearToClass?: string;
    leaveFromClass?: string;
    leaveActiveClass?: string;
    leaveToClass?: string;
}

export declare function useCssModule(name?: string): Record<string, string>;

/**
 * Runtime helper for SFC's CSS variable injection feature.
 * @private
 */
export declare function useCssVars(getter: (ctx: any) => Record<string, string>): void;

export declare const vModelCheckbox: ModelDirective<HTMLInputElement>;

export declare const vModelDynamic: ObjectDirective<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>;

export declare const vModelRadio: ModelDirective<HTMLInputElement>;

export declare const vModelSelect: ModelDirective<HTMLSelectElement>;

export declare const vModelText: ModelDirective<HTMLInputElement | HTMLTextAreaElement>;

export declare const vShow: ObjectDirective<VShowElement>;

declare interface VShowElement extends HTMLElement {
    _vod: string;
}

/**
 * @private
 */
export declare const withKeys: (fn: Function, modifiers: string[]) => (event: KeyboardEvent) => any;

/**
 * @private
 */
export declare const withModifiers: (fn: Function, modifiers: string[]) => (event: Event, ...args: unknown[]) => any;

export * from "@vue/runtime-core";

export { }
