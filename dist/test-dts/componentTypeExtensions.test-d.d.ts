declare module '@vue/runtime-core' {
    interface ComponentCustomOptions {
        test?(n: number): void;
    }
    interface ComponentCustomProperties {
        state: 'stopped' | 'running';
    }
    interface ComponentCustomProps {
        custom?: number;
    }
}
export declare const Custom: import("@vue/runtime-core").DefineComponent<{
    bar: StringConstructor;
    baz: {
        type: NumberConstructor;
        required: true;
    };
}, unknown, {
    counter: number;
}, {}, {
    aMethod(): void;
}, import("@vue/runtime-core").ComponentOptionsMixin, import("@vue/runtime-core").ComponentOptionsMixin, Record<string, any>, string, import("@vue/runtime-core").VNodeProps & import("@vue/runtime-core").AllowedComponentProps & import("@vue/runtime-core").ComponentCustomProps, Readonly<{
    baz: number;
} & {
    bar?: string | undefined;
}>, {}>;
