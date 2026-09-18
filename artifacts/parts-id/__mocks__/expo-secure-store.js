const getItemAsync = jest.fn(async (_key) => null);
const setItemAsync = jest.fn(async (_key, _value) => {});
const deleteItemAsync = jest.fn(async (_key) => {});
const isAvailableAsync = jest.fn(async () => true);

module.exports = { getItemAsync, setItemAsync, deleteItemAsync, isAvailableAsync };
