#include "fray/file_manager.hpp"
#include "fray/state_manager.hpp"

#include <cassert>
#include <filesystem>
#include <fstream>
#include <string>

int main(int argc, char** argv)
{
    assert(argc == 3);
    const std::string path = argv[1];
    {
        fray::files::FileManager files;
        assert(files.open(path) == fray::errors::NONE);
        fray::files::FileManager second;
        assert(second.open(path) == fray::errors::FAILED_OPEN_PROJECT);

        int error = 0;
        zip_t* archive = zip_open(path.c_str(), 0, &error);
        assert(archive != nullptr);
        const char asset[] = "plugin content";
        zip_source_t* assetSource = zip_source_buffer(archive, asset, sizeof(asset) - 1, 0);
        assert(assetSource != nullptr);
        assert(zip_file_add(archive, "plugins/example.txt", assetSource, 0) >= 0);
        assert(zip_close(archive) == 0);

        fray::state::StateManager app;
        fray::state::StateManager plugin;
        assert(app.open(files) == fray::errors::NONE);
        assert(plugin.open(files, "plugin") == fray::errors::NONE);
        assert(files.close() == fray::errors::FAILED_CLOSE_PROJECT);
        assert(app.set("answer", 42) == fray::errors::NONE);
        assert(plugin.set("text", "kept") == fray::errors::NONE);
        assert(app.set("removed", 1) == fray::errors::NONE);
        assert(app.remove("removed") == fray::errors::NONE);
        assert(plugin.renameTable("renamed") == fray::errors::NONE);

        const std::string backup = path + ".bak";
        std::filesystem::rename(path, backup);
        assert(app.set("retry", 7) == fray::errors::FAILED_SAVE_STATE);
        assert(files.close() == fray::errors::FAILED_CLOSE_PROJECT);
        std::filesystem::rename(backup, path);
        assert(files.save() == fray::errors::NONE);
        assert(app.close() == fray::errors::NONE);
        assert(plugin.close() == fray::errors::NONE);
        assert(files.close() == fray::errors::NONE);
    }

    {
        int error = 0;
        zip_t* archive = zip_open(path.c_str(), ZIP_RDONLY | ZIP_CHECKCONS, &error);
        assert(archive != nullptr);
        assert(zip_name_locate(archive, "state.sqlite", 0) >= 0);
        zip_file_t* asset = zip_fopen(archive, "plugins/example.txt", 0);
        assert(asset != nullptr);
        char buffer[32] = {};
        assert(zip_fread(asset, buffer, sizeof(buffer)) == 14);
        assert(std::string(buffer, 14) == "plugin content");
        assert(zip_fclose(asset) == 0);
        zip_discard(archive);
    }

    {
        fray::files::FileManager files;
        assert(files.open(path) == fray::errors::NONE);
        fray::state::StateManager app;
        fray::state::StateManager plugin;
        assert(app.open(files) == fray::errors::NONE);
        assert(plugin.open(files, "renamed") == fray::errors::NONE);
        int value = 0;
        std::string text;
        assert(app.get("answer", value) == fray::errors::NONE && value == 42);
        assert(app.get("retry", value) == fray::errors::NONE && value == 7);
        assert(app.get("removed", value) == fray::errors::STATE_NOT_FOUND);
        assert(plugin.get("text", text) == fray::errors::NONE && text == "kept");
        assert(plugin.removeTable() == fray::errors::NONE);
    }
    {
        fray::files::FileManager files;
        assert(files.open(path) == fray::errors::NONE);
        fray::state::StateManager plugin;
        assert(plugin.open(files, "renamed") == fray::errors::NONE);
        std::string text;
        assert(plugin.get("text", text) == fray::errors::STATE_NOT_FOUND);
    }
    {
        std::ofstream invalid(argv[2], std::ios::binary);
        invalid << "not a zip";
        invalid.close();
        fray::files::FileManager files;
        assert(files.open(argv[2]) == fray::errors::FAILED_OPEN_PROJECT);
        std::ifstream input(argv[2], std::ios::binary);
        std::string contents((std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());
        assert(contents == "not a zip");
    }
    {
        std::filesystem::remove(argv[2]);
        int error = 0;
        zip_t* archive = zip_open(argv[2], ZIP_CREATE | ZIP_EXCL, &error);
        assert(archive != nullptr);
        const char data[] = "keep";
        zip_source_t* source = zip_source_buffer(archive, data, sizeof(data) - 1, 0);
        assert(source != nullptr);
        assert(zip_file_add(archive, "other.txt", source, 0) >= 0);
        assert(zip_close(archive) == 0);
        fray::files::FileManager files;
        assert(files.open(argv[2]) == fray::errors::FAILED_OPEN_PROJECT);
        archive = zip_open(argv[2], ZIP_RDONLY | ZIP_CHECKCONS, &error);
        assert(archive != nullptr && zip_name_locate(archive, "other.txt", 0) >= 0);
        assert(zip_name_locate(archive, "state.sqlite", 0) < 0);
        zip_discard(archive);
    }
}
