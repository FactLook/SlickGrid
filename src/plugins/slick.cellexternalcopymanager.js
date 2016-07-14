(function ( $ )
{
    // register namespace
    $.extend( true, window, {
        "Slick": {
            "CellExternalCopyManager": CellExternalCopyManager
        }
    } );


    function CellExternalCopyManager( options )
    {
        /*
         This manager enables users to copy/paste data from/to an external Spreadsheet application
         such as MS-Excel® or OpenOffice-Spreadsheet.

         Since it is not possible to access directly the clipboard in javascript, the plugin uses
         a trick to do it's job. After detecting the keystroke, we dynamically create a textarea
         where the browser copies/pastes the serialized data.

         options:
         copiedCellStyle : sets the css className used for copied cells. default : "copied"
         copiedCellStyleLayerKey : sets the layer key for setting css values of copied cells. default : "copy-manager"
         dataItemColumnValueExtractor : option to specify a custom column value extractor function
         dataItemColumnValueSetter : option to specify a custom column value setter function
         clipboardCommandHandler : option to specify a custom handler for paste actions
         includeHeaderWhenCopying : set to true and the plugin will take the name property from each column (which is usually what appears in your header) and put that as the first row of the text that's copied to the clipboard
         bodyElement: option to specify a custom DOM element which to will be added the hidden textbox. It's useful if the grid is inside a modal dialog.
         onCopyInit: optional handler to run when copy action initializes
         onCopySuccess: optional handler to run when copy action is complete
         ingoreFormatting: optional array to specify fields of columns that ignore all formatters on paste
         */
        var _grid;
        var _self = this;
        var _copiedRanges;
        var _options = options || {};
        var _copiedCellStyleLayerKey = _options.copiedCellStyleLayerKey || "copy-manager";
        var _copiedCellStyle = _options.copiedCellStyle || "copied";
        var _clearCopyTI = 0;
        var _bodyElement = _options.bodyElement || document.body;
        var _onCopyInit = _options.onCopyInit || null;
        var _onCopySuccess = _options.onCopySuccess || null;
        var _ignoreFormatting = _options.ignoreFormatting || [];

        var keyCodes = {
            'C'  : 67,
            'V'  : 86,
            'ESC': 27
        };

        function init( grid )
        {
            _grid = grid;
            _grid.onKeyDown.subscribe( handleKeyDown );

            // we need a cell selection model
            var cellSelectionModel = grid.getSelectionModel();
            if (!cellSelectionModel)
            {
                throw new Error( "Selection model is mandatory for this plugin. Please set a selection model on the grid before adding this plugin: grid.setSelectionModel(new Slick.CellSelectionModel())" );
            }
            // we give focus on the grid when a selection is done on it.
            // without this, if the user selects a range of cell without giving focus on a particular cell, the grid doesn't get the focus and key stroke handles (ctrl+c) don't work
            //noinspection JSUnusedLocalSymbols,JSUnusedLocalSymbols
            cellSelectionModel.onSelectedRangesChanged.subscribe( function ( e, args )
            {
                _grid.focus();
            } );
        }

        function destroy()
        {
            if(_grid &&  _grid.onKeyDown)
            {
            _grid.onKeyDown.unsubscribe( handleKeyDown );
        	}
        }

        function getDataItemValueForColumn( item, columnDef )
        {
            // If we initialized this with an ignoreFormatting option, don't do fancy formatting
            // on the specified fields (just return the plain JS value)
            for ( var i = 0; i < _ignoreFormatting.length; i++ )
            {
                if (_ignoreFormatting[i] === columnDef.field)
                {
                    return item[columnDef.field];
                }
            }
            if (_options.dataItemColumnValueExtractor)
            {
                return _options.dataItemColumnValueExtractor( item, columnDef );
            }

            var retVal = '';

            // use formatter if available; much faster than editor
            if (columnDef.formatter)
            {
                return columnDef.formatter( 0, 0, item[columnDef.field], columnDef, item );
            }

            // if a custom getter is not defined, we call serializeValue of the editor to serialize
            if (columnDef.editor)
            {
                var editorArgs = {
                    'container': $( "<p>" ),  // a dummy container
                    'column'   : columnDef,
                    'position' : {
                        'top' : 0,
                        'left': 0
                    }  // a dummy position required by some editors
                };
                var editor = new columnDef.editor( editorArgs );
                editor.loadValue( item );
                retVal = editor.serializeValue();
                editor.destroy();
            } else
            {
                retVal = item[columnDef.field];
            }

            return retVal;
        }

        function setDataItemValueForColumn( item, columnDef, value )
        {
            if (_options.dataItemColumnValueSetter)
            {
                return _options.dataItemColumnValueSetter( item, columnDef, value );
            }

            // if a custom setter is not defined, we call applyValue of the editor to unserialize
            if (columnDef.editor)
            {
                var editorArgs = {
                    'container': $( "body" ),  // a dummy container
                    'column'   : columnDef,
                    'position' : {
                        'top' : 0,
                        'left': 0
                    }  // a dummy position required by some editors
                };
                var editor = new columnDef.editor( editorArgs );
                editor.loadValue( item );
                editor.applyValue( item, value );
                editor.destroy();
            }
        }


        function _createTextBox( innerText )
        {
            var ta = document.createElement( 'textarea' );
            ta.style.position = 'absolute';
            ta.style.left = '-1000px';
            ta.style.top = document.body.scrollTop + 'px';
            ta.value = innerText;
            _bodyElement.appendChild( ta );
            ta.select();

            return ta;
        }

        function updateColumnsForGrid( grid, newColumnArray )
        {
            if (!newColumnArray)
            {
                return;
            }

            var minPasteColumnStart = _options.startPasteColumn;
            var columns = grid.getColumns();
            var selectedCell = _grid.getActiveCell();

            //if the selected cell is less then the min cell number for pasting columns
            // then set the selected cell.cell property to the min coulumn number.
            if(selectedCell.cell < minPasteColumnStart){
                selectedCell.cell = minPasteColumnStart;
            }


            //determine if we are just pasting / replacing a column.
            //if we are not pasting more columns than already exist and the selected cell/columns is less then the columns
            //than the current column count, then we are not adding any columns.
            if ((newColumnArray.length < columns.length) && (selectedCell.cell < columns.length))
            {
                return;
            }

            var newColumnIndex = 0;
            var fieldNameStartValue = 0;
            if (_options.fieldNameStartValue)
            {
                fieldNameStartValue = _options.fieldNameStartValue;
            }

            for ( var i = 0; i < newColumnArray.length; i++ )
            {
                var existingColumnIndex = selectedCell.cell + i;
                var column = null;
                if (existingColumnIndex < columns.length)
                {
                    column = columns[existingColumnIndex];
                } else
                {
                    //create a new column.
                    column = {};
                    columns.push( column );
                }


                if (column)
                {
                    column.id = existingColumnIndex;
                    column.field = fieldNameStartValue;
                    column.sortable = true;
                    column.resizable = true;
                    column.rerenderOnResize = true;
                    column.width = 100;
                    column.minWidth = 100;
                    column.editor = Slick.Editors.Text;

                    if (_options.includeHeaderWhenCopying)
                    {
                        column.name = newColumnArray[newColumnIndex];
                    }
                }
                newColumnIndex++;
                fieldNameStartValue++
            }

            grid.setColumns( columns );

        }


        function _buildObjectWithId( columnArray, id, valueArray )
        {
            var dataObject = {
                id: id
            };

            var skipFirstColumn = columnArray[0].field === 'sel';

            for ( var i = 0, len = valueArray.length; i !== len; i++ )
            {
                var column   = columnArray[i];
                if(skipFirstColumn){
                    column   = columnArray[i + 1];
                }

                dataObject[column.field] = valueArray[i];
            }
            return dataObject;
        }

        function _decodeTabularData( _grid, ta )
        {

            var clipText = ta.value;
            var clipRows = clipText.split( /[\n\f\r]/ );
            var clippedRange = [];

            _bodyElement.removeChild( ta );

            for ( var i = 0; i < clipRows.length; i++ )
            {
                if (clipRows[i] != "")
                {
                    clippedRange[i] = clipRows[i].split( "\t" );
                }
            }

                updateColumnsForGrid( _grid, clippedRange[0] );

            var columns = _grid.getColumns();
            var selectedCell = _grid.getActiveCell();
            var ranges = _grid.getSelectionModel().getSelectedRanges();
            var selectedRange = ranges && ranges.length ? ranges[0] : null;   // pick only one selection
            var activeRow = null;
            var activeCell = null;

            if (selectedRange)
            {
                activeRow = selectedRange.fromRow;
                activeCell = selectedRange.fromCell;
            } else if (selectedCell)
            {
                activeRow = selectedCell.row;
                activeCell = selectedCell.cell;
            } else
            {
                // we don't know where to paste
                return;
            }

            var oneCellToMultiple = false;


            var clippedRows = _options.includeHeaderWhenCopying ? clippedRange.length - 1 : clippedRange.length;
            var clippedColumns = clippedRange.length ? clippedRange[0].length : 0;
            if (clippedRange.length == 1 && clippedRange[0].length == 1 && selectedRange)
            {
                oneCellToMultiple = true;
                clippedRows = selectedRange.toRow - selectedRange.fromRow + 1;
                clippedColumns = selectedRange.toCell - selectedRange.fromCell + 1;
            }

            var addRows = 0;
            var availableRows = 0;
            var gridData = _grid.getData();
            var d = gridData;

            if (gridData.constructor.name === "DataView")
            {
                availableRows = gridData.getLength() - activeRow;
                //d = gridData.getItems();
                var gridColumns = _grid.getColumns();
                if (availableRows < clippedRows)
                {
                    gridData.beginUpdate();
                    var numberOfRowsAdded = 0;
                    //start the row count at 1, since the clippedRange[0] are the headers.
                    for ( var rowCount = 1; rowCount <= clippedRows - availableRows; rowCount++ )
                    {
                        //start the id with the activerow, as the active row is where the paste occurred.
                        var id = activeRow + numberOfRowsAdded;


                        var valueData = clippedRange[rowCount];
                        var dataItem = _buildObjectWithId(gridColumns, id,valueData);

                        gridData.addItem( dataItem );
                        numberOfRowsAdded++;
                    }

                    gridData.endUpdate();
                    _grid.render();
                }
            } else
            {
                availableRows = gridData.length - activeRow;
                if (availableRows < clippedRows)
                {
                    //var d = _grid.getData();
                    for ( addRows = 1; addRows <= clippedRows - availableRows; addRows++ )
                    {
                        d.push( {} );
                    }
                    _grid.setData( d );
                    _grid.render();
                }
            }


            var clipCommand = {
                isClipboardCommand       : true,
                clippedRange             : clippedRange,
                oldValues                : [],
                cellExternalCopyManager  : _self,
                _options                 : _options,
                setDataItemValueForColumn: setDataItemValueForColumn,
                markCopySelection        : markCopySelection,
                oneCellToMultiple        : oneCellToMultiple,
                activeRow                : activeRow,
                activeCell               : activeCell,
                clippedRows              : clippedRows,
                clippedColumns           : clippedColumns, //   desty                    : activeRow,
                //  destx                    : activeCell,
                maxDestRows              : _grid.getDataLength(),
                maxDestColumns           : _grid.getColumns().length,
                h                        : 0,
                w                        : 0,
                availableRows            : availableRows,

                execute: function ()
                {
                    this.h = 0;

                    if(availableRows > 0)
                    {
                        var totalClipRows = clippedRange.length;
                        for ( var row = 0; row < clippedRows; row++ )
                        {
                            this.oldValues[row] = [];
                            this.w = 0;
                            this.h++;
                            for ( var column = 0; column < clippedColumns; column++ )
                            {
                                this.w++;
                                var destRow = activeRow + row;
                                var destColumn = activeCell + column;

                                if (destRow < this.maxDestRows && destColumn < this.maxDestColumns)
                                {
                                    var cellNode = _grid.getCellNode( destRow, destColumn );
                                    var dataRow = _grid.getDataItem( destRow );
                                    this.oldValues[row][column] = dataRow[columns[destColumn]['id']];
                                    if (oneCellToMultiple)
                                    {
                                        this.setDataItemValueForColumn( dataRow, columns[destColumn], clippedRange[0][0] );
                                    } else
                                    {
                                        if (_options.includeHeaderWhenCopying)
                                        {
                                            var clippedRowAdjusted = row + 1;
                                            if (clippedRowAdjusted < totalClipRows)
                                            {
                                                this.setDataItemValueForColumn( dataRow, columns[destColumn],
                                                    clippedRange[clippedRowAdjusted] ? clippedRange[clippedRowAdjusted][column] : '' );
                                            }
                                        } else
                                        {
                                            this.setDataItemValueForColumn( dataRow, columns[destColumn],
                                                clippedRange[row] ? clippedRange[row][column] : '' );
                                        }
                                    }
                                    _grid.updateCell( destRow, destColumn );
                                }
                            }
                        }
                    }
                    var bRange = {
                        'fromCell': activeCell,
                        'fromRow' : activeRow,
                        'toCell'  : activeCell + clippedColumns -1,
                        'toRow'   : activeRow + clippedRows -1,
                     /*   'toCell'  : activeCell + this.maxDestColumns - 1,
                        'toRow'   : activeRow + this.maxDestRows - 1,*/
                        'totalRows' : clippedRows,
                        'totalColumns' : clippedColumns
                        //'toCell'  : activeCell + this.w - 1,
                        //'toRow'   : activeRow + this.h - 1
                    };


                    this.markCopySelection( [bRange] );
                    _grid.getSelectionModel().setSelectedRanges( [bRange] );
                    this.cellExternalCopyManager.onPasteCells.notify( {ranges: [bRange]} );
                },

                undo: function ()
                {
                    for ( var y = 0; y < clippedRows; y++ )
                    {
                        for ( var x = 0; x < clippedColumns; x++ )
                        {
                            var desty = activeRow + y;
                            var destx = activeCell + x;

                            if (desty < this.maxDestRows && destx < this.maxDestColumns)
                            {
                                var nd = _grid.getCellNode( desty, destx );
                                var dt = _grid.getDataItem( desty );
                                if (oneCellToMultiple)
                                {
                                    this.setDataItemValueForColumn( dt, columns[destx], this.oldValues[0][0] );
                                } else
                                {
                                    this.setDataItemValueForColumn( dt, columns[destx], this.oldValues[y][x] );
                                }
                                _grid.updateCell( desty, destx );
                            }
                        }
                    }

                    var bRange = {
                        'fromCell': activeCell,
                        'fromRow' : activeRow,
                        'toCell'  : activeCell + this.w - 1,
                        'toRow'   : activeRow + this.h - 1
                    };

                    this.markCopySelection( [bRange] );
                    _grid.getSelectionModel().setSelectedRanges( [bRange] );
                    this.cellExternalCopyManager.onPasteCells.notify( {ranges: [bRange]} );

                    if (addRows > 1)
                    {
                        var d = _grid.getData();
                        for ( ; addRows > 1; addRows-- )
                        {
                            d.splice( d.length - 1, 1 );
                        }
                        _grid.setData( d );
                        _grid.render();
                    }
                }
            };

            if (_options.clipboardCommandHandler)
            {
                _options.clipboardCommandHandler( clipCommand );
            } else
            {
                clipCommand.execute();
            }
        }


        //noinspection JSUnusedLocalSymbols
        function handleKeyDown( e, args )
        {
            var ranges;
            if (!_grid.getEditorLock().isActive() || _grid.getOptions().autoEdit)
            {
                if (e.which == keyCodes.ESC)
                {
                    if (_copiedRanges)
                    {
                        e.preventDefault();
                        clearCopySelection();
                        _self.onCopyCancelled.notify( {ranges: _copiedRanges} );
                        _copiedRanges = null;
                    }
                }

                if (e.which == keyCodes.C && (e.ctrlKey || e.metaKey))
                {    // CTRL + C
                    if (_onCopyInit)
                    {
                        _onCopyInit.call();
                    }
                    ranges = _grid.getSelectionModel().getSelectedRanges();
                    if (ranges.length != 0)
                    {
                        _copiedRanges = ranges;
                        markCopySelection( ranges );
                        _self.onCopyCells.notify( {ranges: ranges} );

                        var columns = _grid.getColumns();
                        var clipText = "";

                        for ( var rg = 0; rg < ranges.length; rg++ )
                        {
                            var range = ranges[rg];
                            var clipTextRows = [];
                            for ( var i = range.fromRow; i < range.toRow + 1; i++ )
                            {
                                var clipTextCells = [];
                                var dt = _grid.getDataItem( i );

                                if (clipTextRows == "" && _options.includeHeaderWhenCopying)
                                {
                                    var clipTextHeaders = [];
                                    for ( var j = range.fromCell; j < range.toCell + 1; j++ )
                                    {
                                        if (columns[j].name.length > 0)
                                        {
                                            clipTextHeaders.push( columns[j].name );
                                        }
                                    }
                                    clipTextRows.push( clipTextHeaders.join( "\t" ) );
                                }

                                for ( var j = range.fromCell; j < range.toCell + 1; j++ )
                                {
                                    clipTextCells.push( getDataItemValueForColumn( dt, columns[j] ) );
                                }
                                clipTextRows.push( clipTextCells.join( "\t" ) );
                            }
                            clipText += clipTextRows.join( "\r\n" ) + "\r\n";
                        }

                        if (window.clipboardData)
                        {
                            window.clipboardData.setData( "Text", clipText );
                            return true;
                        } else
                        {
                            var $focus = $( _grid.getActiveCellNode() );
                            var ta = _createTextBox( clipText );

                            ta.focus();

                            setTimeout( function ()
                            {
                                _bodyElement.removeChild( ta );
                                // restore focus
                                if ($focus && $focus.length > 0)
                                {
                                    $focus.attr( 'tabIndex', '-1' );
                                    $focus.focus();
                                    $focus.removeAttr( 'tabIndex' );
                                }
                            }, 100 );

                            if (_onCopySuccess)
                            {
                                var rowCount = 0;
                                // If it's cell selection, use the toRow/fromRow fields
                                if (ranges.length === 1)
                                {
                                    rowCount = (ranges[0].toRow + 1) - ranges[0].fromRow;
                                } else
                                {
                                    rowCount = ranges.length;
                                }
                                _onCopySuccess.call( this, rowCount );
                            }

                            return false;
                        }
                    }
                }

                if (e.which == keyCodes.V && (e.ctrlKey || e.metaKey))
                {    // CTRL + V
                    var ta = _createTextBox( '' );

                    setTimeout( function ()
                    {
                        _decodeTabularData( _grid, ta );
                    }, 100 );

                    return false;
                }
            }
        }

        function markCopySelection( ranges )
        {
            clearCopySelection();

            var columns = _grid.getColumns();
            var hash = {};
            for ( var i = 0; i < ranges.length; i++ )
            {
                for ( var j = ranges[i].fromRow; j <= ranges[i].toRow; j++ )
                {
                    hash[j] = {};
                    for ( var k = ranges[i].fromCell; k <= ranges[i].toCell && k < columns.length; k++ )
                    {
                        hash[j][columns[k].id] = _copiedCellStyle;
                    }
                }
            }
            _grid.setCellCssStyles( _copiedCellStyleLayerKey, hash );
            clearTimeout( _clearCopyTI );
            _clearCopyTI = setTimeout( function ()
            {
                _self.clearCopySelection();
            }, 2000 );
        }

        function clearCopySelection()
        {
            _grid.removeCellCssStyles( _copiedCellStyleLayerKey );
        }

        $.extend( this, {
            "init"              : init,
            "destroy"           : destroy,
            "clearCopySelection": clearCopySelection,
            "handleKeyDown"     : handleKeyDown,

            "onCopyCells"    : new Slick.Event(),
            "onCopyCancelled": new Slick.Event(),
            "onPasteCells"   : new Slick.Event()
        } );
    }
})( jQuery );
