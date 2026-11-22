#include "fray/state_manager.hpp"
#include "fray/state_manager.hpp"

#include <type_traits>

static_assert(!std::is_copy_constructible<fray::state::StateManager>::value, "StateManager must not be copied");
static_assert(!std::is_copy_assignable<fray::state::StateManager>::value, "StateManager must not be copy-assigned");

F_err verifyStateManagerSeparateTranslationUnit(fray::state::StateManager& state, int& value)
{
    return state.get("shared", value);
}
