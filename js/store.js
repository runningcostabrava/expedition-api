let map, draw;
let activeMarkers = [];
let allCategories = [], allTaskTypes = [];
let mapFilters = { point: true, line: true, smart: true, polygon: true };

const createStore = (initialState) => {
    let state = { ...initialState };
    const listeners = new Map();
    return {
        get: (key) => state[key],
        set: (key, value) => {
            state[key] = value;
            if (listeners.has(key)) listeners.get(key).forEach(fn => fn(value));
        },
        subscribe: (key, fn) => {
            if (!listeners.has(key)) listeners.set(key, new Set());
            listeners.get(key).add(fn);
            return () => listeners.get(key).delete(fn);
        }
    };
};

const AppStore = createStore({
    itinerary: [],
    sections: [],
    activeTaskId: null
});
